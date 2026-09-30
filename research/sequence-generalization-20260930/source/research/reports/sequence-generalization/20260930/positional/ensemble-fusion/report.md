# Generic positional / existing Ensemble fusion

Selection uses overall reference group Top1 then Top3. Both component candidates are all-library classifiers. Fixed weights are .25/.5/.75; optional gates use the baseline's standardized Top1–Top2 gap .25/.5 for every class. Fixed holdout and prospective answers are not read.

| Config | Group Top1 | Top3 | Pair global Top1 | Pair conditional |
|---|---:|---:|---:|---:|
| all_sequence_lda_s0.15_w0.75_gap0.25 | 90.094% | 100.000% | 45.833% | 45.833% |
| all_sequence_lda_s0.15_w0.75_gapNone | 89.780% | 100.000% | 45.833% | 45.833% |
| all_sequence_lda_s0.15_w0.75_gap0.5 | 89.780% | 100.000% | 45.833% | 45.833% |
| position4_only_lda_s0.15_w0.25_gapNone | 89.780% | 99.843% | 58.333% | 58.333% |
| position4_only_lda_s0.15_w0.25_gap0.25 | 89.780% | 99.843% | 58.333% | 58.333% |
| position4_only_lda_s0.15_w0.25_gap0.5 | 89.780% | 99.843% | 58.333% | 58.333% |
| all_sequence_lda_s0.15_w0.5_gap0.25 | 89.308% | 100.000% | 41.667% | 41.667% |
| position4_only_lda_s0.15_w0.5_gap0.25 | 89.308% | 100.000% | 62.500% | 62.500% |
| all_sequence_lda_s0.15_w0.5_gapNone | 89.151% | 100.000% | 41.667% | 41.667% |
| all_sequence_lda_s0.15_w0.5_gap0.5 | 89.151% | 100.000% | 41.667% | 41.667% |
| position4_only_lda_s0.15_w0.5_gapNone | 89.151% | 100.000% | 62.500% | 62.500% |
| position4_only_lda_s0.15_w0.5_gap0.5 | 89.151% | 100.000% | 62.500% | 62.500% |
| all_sequence_lda_s0.15_w0.25_gapNone | 88.994% | 100.000% | 41.667% | 41.667% |
| all_sequence_lda_s0.15_w0.25_gap0.25 | 88.994% | 100.000% | 41.667% | 41.667% |
| all_sequence_lda_s0.15_w0.25_gap0.5 | 88.994% | 100.000% | 41.667% | 41.667% |
| position4_only_lda_s0.15_w0.75_gap0.25 | 88.994% | 100.000% | 58.333% | 62.500% |
| position4_only_lda_s0.15_w0.75_gap0.5 | 88.208% | 99.843% | 58.333% | 62.500% |
| position4_only_lda_s0.15_w0.75_gapNone | 86.321% | 99.686% | 58.333% | 62.500% |

Selected `all_sequence_lda_s0.15_w0.75_gap0.25`. Nested leave-two-environment calibration NLL 0.2177, Brier 0.1368, ECE10 0.0281.

Feature/candidate selection precedes nested calibration, so calibration remains conditional on exploratory reference selection. Independent validation is required for a delivery claim.
