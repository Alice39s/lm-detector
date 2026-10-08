"""Shrinkage LDA on frequency, ordered-block, position-kernel and sequence features (751 dims)."""
import numpy as np
from scipy.linalg import eigh

from fingerprint import count_numbers, hellinger_feature, ordered_block_feature

WEIGHTS = {'frequency': .6, 'ordered': .15, 'kernel': .125, 'sequence': .125}
CENTRES = np.linspace(1, 355, 24)
LAGS = (1, 2, 3, 5, 8, 13, 21, 34)


def relative_basis(n):
    t = (np.arange(n) + .5) * 2 / n - 1
    return np.c_[t, .5 * (3 * t * t - 1), .5 * (5 * t ** 3 - 3 * t)]


def position_kernel(x):
    """Value RBF and last-digit indicators weighted by Legendre position polynomials."""
    rbf = np.exp(-.5 * ((x[:, None] - CENTRES) / 20) ** 2)
    return (np.c_[rbf, np.eye(10)[x % 10]].T @ relative_basis(len(x)) / len(x)).ravel()


def sequence_features(x):
    v = x.astype(float)
    n = len(v)
    s = (v - v.mean()) / max(v.std(), 1)
    out = []
    for lag in LAGS:
        d = v[lag:] - v[:-lag]
        out += [np.mean(s[lag:] * s[:-lag]), np.mean(np.abs(d)) / 355, np.mean(d > 0),
                np.mean(d == 0), np.mean(np.abs(d) <= 5), np.mean(np.abs(d) <= 20)]
    for bins, symbols in ((8, np.minimum(7, (x - 1) * 8 // 355)), (10, x % 10)):
        joint = np.bincount(symbols[:-1] * bins + symbols[1:], minlength=bins * bins).reshape(bins, bins)
        joint = (joint + .5) / (n - 1 + .5 * joint.size)
        joint -= joint.sum(1, keepdims=True) * joint.sum(0, keepdims=True)
        out += list(joint.ravel())
    difference = np.diff(v)
    signs = np.sign(difference)
    out += [np.mean(signs[1:] == signs[:-1]), np.mean(difference[1:] == difference[:-1]),
            np.mean(x[:-1] % 10 == x[1:] % 10), np.mean(np.abs(np.diff(s)) > 1), np.mean(np.abs(np.diff(s)) > 2)]
    buckets = np.minimum(15, (x - 1) * 16 // 355)
    for width in (4, 8, 16):
        out.append(np.mean([len(set(buckets[i:i + width])) / width for i in range(n - width + 1)]))
    return np.asarray(out)


def feature_parts(numbers):
    """Per-answer feature blocks stacked over answers, keyed in WEIGHTS order."""
    parts = {name: [] for name in WEIGHTS}
    for n in numbers:
        x = np.asarray(n, int)
        parts['frequency'].append(hellinger_feature(count_numbers(n)))
        parts['ordered'].append(ordered_block_feature(n))
        parts['kernel'].append(position_kernel(x))
        parts['sequence'].append(sequence_features(x))
    return {name: np.stack(value) for name, value in parts.items()}


def transform(parts, params):
    output = []
    for (name, weight), p in zip(WEIGHTS.items(), params):
        x = (parts[name] - p['mean']) / p['scale']
        output.append(x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12) * np.sqrt(weight))
    return np.concatenate(output, axis=1)


class PositionalLDA:
    def __init__(self, numbers, labels, classes, shrinkage):
        parts = feature_parts(numbers)
        self.params = []
        for name in WEIGHTS:
            scale = parts[name].std(0)
            scale[scale < 1e-10] = 1
            self.params.append(dict(mean=parts[name].mean(0), scale=scale))
        x = transform(parts, self.params)
        centres = np.stack([x[labels == k].mean(0) for k in range(classes)])
        residual = x - centres[labels]
        covariance = residual.T @ residual / len(residual)
        values, vectors = eigh(covariance, check_finite=False)
        target = max(np.trace(covariance) / len(covariance), 1e-12)
        denominator = (1 - shrinkage) * np.maximum(values, 0) + shrinkage * target
        self.coefficient = (vectors @ ((vectors.T @ centres.T) / denominator[:, None])).T
        self.intercept = -.5 * np.sum(centres * self.coefficient, axis=1)

    def decision(self, numbers):
        """Raw per-answer decision values, shape (answers, identities)."""
        return transform(feature_parts(numbers), self.params) @ self.coefficient.T + self.intercept
