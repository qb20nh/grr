import argparse
import struct
from pathlib import Path
from typing import Tuple

import numpy as np
import torch


MAGIC = b"GRRNNUE1"
VERSION = 1

BOARD_SIZE = 15
FEATURE_COUNT = 450


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Export trained NNUE model to runtime weights.bin")
    p.add_argument("--checkpoint", default="training/nnue/checkpoints/model.pt", help="Input checkpoint path")
    p.add_argument("--out", default="static/nnue/weights.bin", help="Output weights.bin path")
    return p.parse_args()


def _quantize_int8(x: np.ndarray) -> Tuple[np.ndarray, float]:
    max_abs = float(np.max(np.abs(x))) if x.size else 0.0
    if max_abs <= 1e-12:
        scale = 1.0
        q = np.zeros_like(x, dtype=np.int8)
        return q, scale
    scale = max_abs / 127.0
    q = np.clip(np.round(x / scale), -127, 127).astype(np.int8)
    return q, scale


def _quantize_int16(x: np.ndarray, scale: float) -> np.ndarray:
    if scale <= 0:
        raise ValueError("scale must be > 0")
    q = np.round(x / scale)
    q = np.clip(q, -32768, 32767).astype(np.int16)
    return q


def main() -> None:
    args = parse_args()

    ckpt = torch.load(args.checkpoint, map_location="cpu")
    state = ckpt["state_dict"]
    cfg = ckpt.get("cfg", {})
    hidden_dim = int(cfg.get("hidden_dim", 64))
    feature_count = int(cfg.get("feature_count", FEATURE_COUNT))
    if feature_count != FEATURE_COUNT:
        raise ValueError(f"Unexpected feature_count={feature_count} (expected {FEATURE_COUNT})")

    # Extract tensors.
    in_w = state["in_w"].detach().cpu().numpy().astype(np.float32)  # [F,H]
    hidden_b = state["hidden_b"].detach().cpu().numpy().astype(np.float32)  # [H]
    out_w = state["out_w"].detach().cpu().numpy().astype(np.float32)  # [H]

    out_b = float(state["out_b"].detach().cpu().item())
    phase_w = float(state["phase_w"].detach().cpu().item())
    stm_w = float(state["stm_w"].detach().cpu().item())

    if in_w.shape != (FEATURE_COUNT, hidden_dim):
        raise ValueError(f"Bad in_w shape {in_w.shape}, expected {(FEATURE_COUNT, hidden_dim)}")
    if hidden_b.shape != (hidden_dim,):
        raise ValueError("Bad hidden_b shape")
    if out_w.shape != (hidden_dim,):
        raise ValueError("Bad out_w shape")

    # Quantize weights.
    in_w_q, in_scale = _quantize_int8(in_w)
    out_w_q, out_scale = _quantize_int8(out_w)

    # Convert float biases to accumulator integer units.
    hidden_b_q = _quantize_int16(hidden_b, in_scale)

    # Runtime computes: tanh((dot_int + bias_int + phase_int*phase + stm_int*stm) / outputScale)
    # where dot_int is integer and outputScale is float.
    # To approximate float model z = dot_f + out_b + phase_w*phase + stm_w*stm:
    #   dot_f ≈ dot_int * (in_scale * out_scale)
    # so we set outputScale = 1/(in_scale*out_scale) and convert the scalar params into dot_int units.
    scale_prod = in_scale * out_scale
    if scale_prod <= 0:
        raise ValueError("Invalid quantization scales")
    output_scale = 1.0 / scale_prod

    out_b_int = out_b / scale_prod
    phase_w_int = phase_w / scale_prod
    stm_w_int = stm_w / scale_prod

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with open(out_path, "wb") as f:
        f.write(MAGIC)
        f.write(struct.pack("<I", VERSION))
        f.write(struct.pack("<H", BOARD_SIZE))
        f.write(struct.pack("<H", FEATURE_COUNT))
        f.write(struct.pack("<H", hidden_dim))
        f.write(struct.pack("<H", 0))  # reserved
        f.write(struct.pack("<f", float(output_scale)))
        f.write(struct.pack("<f", float(phase_w_int)))
        f.write(struct.pack("<f", float(stm_w_int)))
        f.write(struct.pack("<f", float(out_b_int)))

        f.write(hidden_b_q.tobytes(order="C"))
        f.write(in_w_q.tobytes(order="C"))
        f.write(out_w_q.tobytes(order="C"))

    print("[export] wrote", str(out_path), {"hidden_dim": hidden_dim, "output_scale": output_scale})


if __name__ == "__main__":
    main()

