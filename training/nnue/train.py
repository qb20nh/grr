import argparse
import json
from pathlib import Path
from typing import Dict, Any
import time

import torch
from torch.utils.data import DataLoader, Subset

from dataset import SelfPlayDataset, AugmentConfig
from model import NnueModel, ModelConfig


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Train NNUE value net on self-play dataset.")
    p.add_argument("--dataset", required=True, help="Path to training/data/selfplay.bin")
    p.add_argument("--out", default="training/nnue/checkpoints/model.pt", help="Output checkpoint path")
    p.add_argument("--log", default="", help="Optional JSONL log path (default: <outDir>/log.jsonl)")
    p.add_argument("--init", default="", help="Optional init checkpoint (.pt) to warm-start from")
    p.add_argument("--hiddenDim", type=int, default=128)
    p.add_argument("--batchSize", type=int, default=2048)
    p.add_argument("--epochs", type=int, default=5)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--device", default="cpu")

    # Augmentation knobs
    p.add_argument("--noD4", action="store_true")
    p.add_argument("--noTranslate", action="store_true")
    p.add_argument("--translateMargin", type=int, default=3)
    p.add_argument("--translatePhaseThreshold", type=int, default=90)

    p.add_argument("--valFraction", type=float, default=0.05)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    torch.manual_seed(args.seed)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    log_path = Path(args.log) if args.log else (out_path.parent / "log.jsonl")
    log_path.parent.mkdir(parents=True, exist_ok=True)

    augment = AugmentConfig(
        enable_d4=not args.noD4,
        enable_translation=not args.noTranslate,
        translation_margin=args.translateMargin,
        translation_phase_threshold=args.translatePhaseThreshold,
    )
    ds = SelfPlayDataset(args.dataset, augment=augment, seed=args.seed)

    # Shuffle indices once for train/val split.
    g = torch.Generator().manual_seed(args.seed)
    perm = torch.randperm(len(ds), generator=g).tolist()
    val_n = max(1, int(len(ds) * float(args.valFraction)))
    val_idx = perm[:val_n]
    train_idx = perm[val_n:]

    train = Subset(ds, train_idx)
    val = Subset(ds, val_idx)

    train_loader = DataLoader(train, batch_size=args.batchSize, shuffle=True, num_workers=0)
    val_loader = DataLoader(val, batch_size=args.batchSize, shuffle=False, num_workers=0)

    device = torch.device(args.device)
    cfg = ModelConfig(feature_count=450, hidden_dim=int(args.hiddenDim))
    model = NnueModel(cfg).to(device)

    init_path = Path(args.init) if args.init else None
    if init_path is not None and init_path.exists():
        init = torch.load(init_path, map_location="cpu")
        state_dict = init.get("state_dict") if isinstance(init, dict) else None
        init_cfg = init.get("cfg") if isinstance(init, dict) else None
        if not isinstance(state_dict, dict):
            raise ValueError(f"init checkpoint missing state_dict: {init_path}")
        if isinstance(init_cfg, dict):
            if int(init_cfg.get("feature_count", cfg.feature_count)) != cfg.feature_count:
                raise ValueError("init checkpoint feature_count mismatch")
            if int(init_cfg.get("hidden_dim", cfg.hidden_dim)) != cfg.hidden_dim:
                raise ValueError("init checkpoint hidden_dim mismatch")
        model.load_state_dict(state_dict, strict=True)
        print("[train] init", str(init_path))

    opt = torch.optim.Adam(model.parameters(), lr=float(args.lr))
    loss_fn = torch.nn.MSELoss()

    def run_eval() -> Dict[str, Any]:
        model.eval()
        total = 0.0
        n = 0
        with torch.no_grad():
            for feat, phase, stm, target in val_loader:
                feat = feat.to(device)
                phase = phase.to(device)
                stm = stm.to(device)
                target = target.squeeze(-1).to(device)
                pred = model(feat, phase, stm)
                loss = loss_fn(pred, target)
                total += float(loss.item()) * feat.size(0)
                n += feat.size(0)
        return {"val_mse": total / max(1, n)}

    for epoch in range(args.epochs):
        epoch_start = time.time()
        model.train()
        total = 0.0
        n = 0
        for feat, phase, stm, target in train_loader:
            feat = feat.to(device)
            phase = phase.to(device)
            stm = stm.to(device)
            target = target.squeeze(-1).to(device)

            pred = model(feat, phase, stm)
            loss = loss_fn(pred, target)

            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()

            total += float(loss.item()) * feat.size(0)
            n += feat.size(0)

        stats = {"epoch": epoch + 1, "train_mse": total / max(1, n)}
        stats.update(run_eval())
        stats["lr"] = float(args.lr)
        stats["epoch_time_sec"] = float(time.time() - epoch_start)
        print("[train]", stats)

        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(stats) + "\n")

    torch.save(
        {
            "state_dict": model.state_dict(),
            "cfg": {"feature_count": cfg.feature_count, "hidden_dim": cfg.hidden_dim},
            "augment": {
                "d4": augment.enable_d4,
                "translate": augment.enable_translation,
                "translate_margin": augment.translation_margin,
                "translate_phase_threshold": augment.translation_phase_threshold,
            },
        },
        out_path,
    )
    print("[train] saved", str(out_path))
    print("[train] log", str(log_path))


if __name__ == "__main__":
    main()

