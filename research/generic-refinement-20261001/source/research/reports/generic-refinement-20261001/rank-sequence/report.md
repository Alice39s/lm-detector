# Empirical-rank sequence refinement

Thirty predeclared generic candidates used only the frozen 53-label reference library.
Ordinal, run and recurrence nulls condition on each reply's own marginal counts. Midranks retain ties; Fourier coefficients retain phase.

Selection uses all-library Top1, macro Top1 and MRR. Astra/Sol metrics are reported after selection.

| Candidate | Top1 / 636 | Top3 / 636 | MRR | Pair / 24 |
|---|---:|---:|---:|---:|
| all_sequence_heavy_lda_0.5 | 567 | 636 | 0.94444 | 13 |
| all_balanced_ridge_1 | 565 | 632 | 0.94009 | 11 |
| spectral_lda_0.5 | 564 | 636 | 0.94287 | 10 |
| all_sequence_heavy_lda_0.85 | 564 | 635 | 0.94143 | 16 |
| recurrence_ridge_1 | 564 | 633 | 0.93995 | 10 |
| ordinal_lda_0.15 | 563 | 636 | 0.94209 | 11 |
| all_balanced_lda_0.5 | 563 | 636 | 0.94104 | 11 |
| recurrence_lda_0.5 | 562 | 636 | 0.94078 | 10 |
| all_balanced_lda_0.85 | 562 | 636 | 0.94051 | 15 |
| all_sequence_heavy_lda_0.15 | 561 | 636 | 0.94025 | 10 |
| spectral_lda_0.85 | 561 | 636 | 0.93947 | 11 |
| ordinal_ridge_1 | 560 | 633 | 0.93649 | 10 |
| ordinal_lda_0.5 | 560 | 636 | 0.93920 | 10 |
| all_sequence_heavy_ridge_1 | 560 | 632 | 0.93638 | 13 |
| recurrence_lda_0.15 | 559 | 636 | 0.93894 | 11 |
| all_balanced_lda_0.15 | 559 | 636 | 0.93868 | 9 |
| recurrence_lda_0.85 | 559 | 635 | 0.93789 | 12 |
| ordinal_lda_0.85 | 558 | 636 | 0.93711 | 10 |
| spectral_lda_0.15 | 557 | 636 | 0.93711 | 9 |
| all_balanced_ridge_10 | 557 | 630 | 0.93411 | 14 |
| spectral_ridge_1 | 555 | 631 | 0.93242 | 9 |
| all_sequence_heavy_ridge_10 | 555 | 629 | 0.93040 | 15 |
| spectral_ridge_10 | 553 | 630 | 0.93014 | 11 |
| recurrence_ridge_10 | 552 | 634 | 0.93041 | 12 |
| ordinal_ridge_10 | 545 | 631 | 0.92423 | 12 |
| sequence_only_lda_0.5 | 431 | 569 | 0.79456 | 13 |
| sequence_only_lda_0.15 | 430 | 576 | 0.79765 | 13 |
| sequence_only_lda_0.85 | 403 | 558 | 0.76388 | 13 |
| sequence_only_ridge_1 | 373 | 529 | 0.72305 | 15 |
| sequence_only_ridge_10 | 353 | 519 | 0.69939 | 15 |

Winner temperature fitted to reference OOF development scores only; post-selection, not independently authenticated identity probability.; candidate selection shares the reference folds and retains collection-channel confounding.
No fixed holdout, matched pair or new prospective data was read. No model API was called.
