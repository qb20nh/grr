import struct
from dataclasses import dataclass
from typing import Tuple

import numpy as np
import torch
from torch.utils.data import Dataset


BLACK = 1
WHITE = 2

BOARD_SIZE = 15
CELLS = BOARD_SIZE * BOARD_SIZE  # 225
FEATURES = CELLS * 2  # black plane + white plane

MAGIC = b"GRRSP001"
HEADER_BYTES = 8 + 4 + 4  # magic + version + recordCount
RECORD_BYTES = CELLS + 1 + 1  # cells + toMove + resultFromBlack(int8)


def _apply_d4(x: np.ndarray, code: int) -> np.ndarray:
    """
    Apply a dihedral (D4) transform to a 2D array.
    code in [0..7]: rotations 0..3, then (flipLR + rotations 0..3).
    """
    if code < 4:
        return np.rot90(x, code)
    return np.fliplr(np.rot90(x, code - 4))


def _shift_board(x: np.ndarray, dr: int, dc: int) -> np.ndarray:
    """
    Shift a 2D array by (dr, dc) with zero fill.
    Positive dr shifts down; positive dc shifts right.
    """
    if dr == 0 and dc == 0:
        return x

    out = np.zeros_like(x)
    r0_src = max(0, -dr)
    r0_dst = max(0, dr)
    r_len = BOARD_SIZE - abs(dr)

    c0_src = max(0, -dc)
    c0_dst = max(0, dc)
    c_len = BOARD_SIZE - abs(dc)

    if r_len <= 0 or c_len <= 0:
        return out

    out[r0_dst : r0_dst + r_len, c0_dst : c0_dst + c_len] = x[r0_src : r0_src + r_len, c0_src : c0_src + c_len]
    return out


@dataclass(frozen=True)
class AugmentConfig:
    enable_d4: bool = True
    enable_translation: bool = True
    # Require at least this margin from all edges to apply translation.
    translation_margin: int = 2
    # Only translate in earlier phases (stone count <= threshold).
    translation_phase_threshold: int = 120


class SelfPlayDataset(Dataset):
    """
    Dataset of (features, phase, stm, target) where:
      - features: float32[450] (binary planes)
      - phase: float32[1] in [0,1]
      - stm: float32[1] = +1 (black to move) or -1 (white to move)
      - target: float32[1] in [-1,1] value for side-to-move

    Augmentations:
      - Always D4 (rotation/reflection) if enabled
      - Conditional translation (semi-translation-agnostic) if enabled
    """

    def __init__(self, path: str, augment: AugmentConfig = AugmentConfig(), seed: int = 1) -> None:
        self.path = path
        self.augment = augment
        self.rng = np.random.default_rng(seed)

        with open(path, "rb") as f:
            header = f.read(HEADER_BYTES)
        if len(header) != HEADER_BYTES:
            raise ValueError("dataset header truncated")
        if header[:8] != MAGIC:
            raise ValueError("bad dataset magic")
        version, record_count = struct.unpack("<II", header[8:16])
        if version != 1:
            raise ValueError(f"unsupported dataset version {version}")
        if record_count <= 0:
            raise ValueError("empty dataset")

        self.record_count = int(record_count)
        self.mm = np.memmap(
            path,
            dtype=np.uint8,
            mode="r",
            offset=HEADER_BYTES,
            shape=(self.record_count, RECORD_BYTES),
        )

    def __len__(self) -> int:
        return self.record_count

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        rec = self.mm[idx]

        cells = rec[:CELLS].reshape((BOARD_SIZE, BOARD_SIZE))
        to_move = int(rec[CELLS])
        result_black = np.int8(rec[CELLS + 1]).item()  # -1/0/1

        black = (cells == BLACK)
        white = (cells == WHITE)

        # D4 augmentation.
        if self.augment.enable_d4:
            code = int(self.rng.integers(0, 8))
            black = _apply_d4(black, code)
            white = _apply_d4(white, code)

        stone_mask = black | white
        stone_count = int(stone_mask.sum())

        # Conditional translation augmentation (interior + earlier phase).
        if self.augment.enable_translation and stone_count <= self.augment.translation_phase_threshold:
            if stone_count == 0:
                margin = BOARD_SIZE // 2
            else:
                rows, cols = np.where(stone_mask)
                min_r = int(rows.min())
                max_r = int(rows.max())
                min_c = int(cols.min())
                max_c = int(cols.max())
                margin = min(min_r, min_c, (BOARD_SIZE - 1) - max_r, (BOARD_SIZE - 1) - max_c)

            if margin >= self.augment.translation_margin:
                max_shift = margin - self.augment.translation_margin
                if max_shift > 0:
                    dr = int(self.rng.integers(-max_shift, max_shift + 1))
                    dc = int(self.rng.integers(-max_shift, max_shift + 1))
                    black = _shift_board(black, dr, dc)
                    white = _shift_board(white, dr, dc)
                    stone_count = int((black | white).sum())

        # Target from side-to-move perspective.
        target = float(result_black if to_move == BLACK else -result_black)

        # Scalar features
        phase = float(stone_count) / float(CELLS)
        stm = 1.0 if to_move == BLACK else -1.0

        feat = np.concatenate([black.reshape(-1), white.reshape(-1)]).astype(np.float32, copy=False)

        return (
            torch.from_numpy(feat),
            torch.tensor([phase], dtype=torch.float32),
            torch.tensor([stm], dtype=torch.float32),
            torch.tensor([target], dtype=torch.float32),
        )

