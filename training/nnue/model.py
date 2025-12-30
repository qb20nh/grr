from dataclasses import dataclass

import torch
from torch import nn


@dataclass(frozen=True)
class ModelConfig:
    feature_count: int = 450
    hidden_dim: int = 64


class NnueModel(nn.Module):
    """
    NNUE-style value model matching the runtime evaluator:
      hidden = bias + features @ W_in
      z = outBias + phaseW*phase + stmW*stm + relu(hidden) @ W_out
      value = tanh(z)
    """

    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        self.cfg = cfg

        self.in_w = nn.Parameter(torch.empty(cfg.feature_count, cfg.hidden_dim))
        self.hidden_b = nn.Parameter(torch.zeros(cfg.hidden_dim))
        self.out_w = nn.Parameter(torch.empty(cfg.hidden_dim))

        self.out_b = nn.Parameter(torch.zeros(()))
        self.phase_w = nn.Parameter(torch.zeros(()))
        self.stm_w = nn.Parameter(torch.zeros(()))

        nn.init.normal_(self.in_w, mean=0.0, std=0.01)
        nn.init.normal_(self.out_w, mean=0.0, std=0.01)

    def forward(self, features: torch.Tensor, phase: torch.Tensor, stm: torch.Tensor) -> torch.Tensor:
        # features: [B, F] float32 (0/1)
        # phase: [B, 1]
        # stm: [B, 1]
        hidden = features @ self.in_w + self.hidden_b
        z = (torch.relu(hidden) @ self.out_w) + self.out_b + (self.phase_w * phase.squeeze(-1)) + (self.stm_w * stm.squeeze(-1))
        return torch.tanh(z)

