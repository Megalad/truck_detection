"""One place that decides which device runs the models.

Set YOLO_DEVICE to force one ("cuda:0", "mps", "cpu", ...). Otherwise the best
available is picked: CUDA (e.g. an AWS GPU instance) > MPS (Apple silicon) > CPU.
"""
import os

import torch


def pick_device(requested=None):
    requested = requested or os.environ.get("YOLO_DEVICE")
    if requested and requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda:0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"
