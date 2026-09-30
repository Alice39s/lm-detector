# Generic sequence fingerprints: reference-only screen

53 models, 1948 reference answers, 636 three-answer groups. 12 leave-one-environment-out folds; all responses in a held environment excluded from training.

The grid is exploratory reference selection. Its best score is not an independent validation result. Neither the frozen holdout nor prospective samples were read. Confidence calibration uses leave-two-environment-out inner predictions, conditioned on the selected candidate.

| Candidate | Single Top1 | Group Top1 | Group Top3 | Pair global Top1 | Pair conditional |
|---|---:|---:|---:|---:|---:|
| all_sequence_lda_s0.15 | 82.338% | 89.780% | 99.843% | 54.167% | 54.167% |
| all_sequence_lda_s0.5 | 82.390% | 89.465% | 100.000% | 50.000% | 50.000% |
| existing_kernel_lda_s0.15 | 82.023% | 88.994% | 100.000% | 50.000% | 50.000% |
| frequency_position8_lda_s0.15 | 79.717% | 88.679% | 100.000% | 45.833% | 45.833% |
| frequency_position8_lda_s0.5 | 79.455% | 88.679% | 100.000% | 45.833% | 45.833% |
| existing_sequence_lda_s0.5 | 81.132% | 88.679% | 100.000% | 45.833% | 45.833% |
| frequency_kernel_lda_s0.15 | 80.975% | 88.365% | 100.000% | 54.167% | 54.167% |
| existing_kernel_lda_s0.5 | 81.551% | 88.365% | 100.000% | 41.667% | 41.667% |
| existing_sequence_lda_s0.15 | 80.398% | 88.365% | 100.000% | 58.333% | 58.333% |
| existing_blocks_lda_s0.5 | 80.398% | 88.365% | 99.843% | 41.667% | 41.667% |
| existing_sequence_lda_s0.85 | 80.136% | 88.208% | 100.000% | 41.667% | 41.667% |
| frequency_kernel_lda_s0.5 | 80.451% | 88.208% | 99.843% | 45.833% | 45.833% |
| existing_blocks_lda_s0.15 | 80.346% | 88.050% | 100.000% | 41.667% | 41.667% |
| frequency_position4_lda_s0.5 | 80.084% | 88.050% | 99.843% | 41.667% | 41.667% |
| existing_blocks_lda_s0.85 | 78.040% | 88.050% | 99.528% | 45.833% | 45.833% |
| frequency_position4_lda_s0.85 | 77.987% | 88.050% | 99.528% | 50.000% | 50.000% |
| frequency_association_lda_s0.15 | 79.350% | 87.893% | 100.000% | 50.000% | 50.000% |
| frequency_position8_lda_s0.85 | 77.673% | 87.893% | 99.528% | 50.000% | 50.000% |
| frequency_position4_lda_s0.15 | 79.874% | 87.736% | 100.000% | 41.667% | 41.667% |
| all_sequence_lda_s0.85 | 81.447% | 87.736% | 100.000% | 37.500% | 37.500% |
| frequency_lda_s0.15 | 77.254% | 87.579% | 99.843% | 50.000% | 50.000% |
| existing_kernel_lda_s0.85 | 80.660% | 87.579% | 99.686% | 37.500% | 37.500% |
| frequency_association_lda_s0.85 | 78.302% | 87.579% | 99.528% | 50.000% | 50.000% |
| frequency_association_lda_s0.5 | 79.560% | 87.421% | 100.000% | 41.667% | 41.667% |
| frequency_sequence_lda_s0.5 | 79.298% | 87.421% | 100.000% | 41.667% | 41.667% |
| frequency_value_moments_lda_s0.5 | 80.084% | 87.421% | 100.000% | 37.500% | 37.500% |
| frequency_kernel_lda_s0.85 | 78.616% | 87.421% | 99.528% | 45.833% | 45.833% |
| frequency_first_occurrence_lda_s0.5 | 79.927% | 87.264% | 100.000% | 33.333% | 33.333% |
| frequency_sequence_lda_s0.85 | 78.669% | 87.264% | 99.686% | 45.833% | 45.833% |
| frequency_lda_s0.85 | 76.153% | 87.264% | 99.371% | 45.833% | 45.833% |
| frequency_lda_s0.5 | 77.725% | 86.950% | 99.686% | 45.833% | 45.833% |
| frequency_sequence_lda_s0.15 | 78.459% | 86.792% | 100.000% | 50.000% | 50.000% |
| frequency_first_occurrence_lda_s0.85 | 77.830% | 86.635% | 99.843% | 41.667% | 41.667% |
| frequency_value_moments_lda_s0.85 | 78.040% | 86.478% | 99.686% | 37.500% | 37.500% |
| frequency_kernel_centroid | 75.996% | 86.478% | 99.214% | 41.667% | 45.833% |
| frequency_association_centroid | 76.310% | 86.478% | 99.057% | 50.000% | 50.000% |
| frequency_sequence_centroid | 75.943% | 86.006% | 99.057% | 45.833% | 45.833% |
| existing_blocks_centroid | 75.105% | 85.849% | 99.057% | 50.000% | 50.000% |
| frequency_centroid | 74.476% | 85.692% | 98.899% | 50.000% | 50.000% |
| position4_only_lda_s0.15 | 53.407% | 79.088% | 95.912% | 66.667% | 70.833% |
| position4_only_lda_s0.5 | 52.411% | 78.145% | 94.811% | 70.833% | 75.000% |
| position4_only_lda_s0.85 | 49.581% | 75.314% | 94.025% | 62.500% | 70.833% |
| kernel_only_lda_s0.15 | 43.187% | 72.170% | 92.138% | 37.500% | 41.667% |
| kernel_only_lda_s0.5 | 40.461% | 69.969% | 89.780% | 37.500% | 37.500% |
| sequence_only_lda_s0.15 | 41.929% | 68.239% | 90.881% | 58.333% | 58.333% |
| sequence_only_lda_s0.5 | 39.203% | 66.195% | 88.522% | 58.333% | 62.500% |
| sequence_only_lda_s0.85 | 37.579% | 65.566% | 86.478% | 58.333% | 62.500% |
| kernel_only_lda_s0.85 | 36.688% | 65.094% | 87.579% | 45.833% | 45.833% |

Macro Top1 equals group Top1 because each model contributes 12 groups.

Position histograms preserve normalized placement. Residual joint histograms remove marginals. Kernel moments correlate numeric RBF and last-digit basis functions with three relative-position Legendre polynomials. Exact-value moments use 355 indicators and two position polynomials. Sequence statistics include lagged autocorrelation, difference/rank tendencies and residual coarse-value/last-digit transitions.

Selected candidate: `all_sequence_lda_s0.15`.
Nested calibration: NLL 0.2183; Brier 0.1416; ECE10 0.0371.

| Scope | Threshold | Accepted | Errors | Coverage | 95% error upper bound |
|---|---:|---:|---:|---:|---:|
| all | 0.8 | 506 | 12 | 79.560% | 3.814% |
| all | 0.9 | 464 | 3 | 72.956% | 1.663% |
| all | 0.95 | 430 | 1 | 67.610% | 1.098% |
| all | 0.99 | 357 | 0 | 56.132% | 0.836% |
| pair | 0.8 | 3 | 1 | 12.500% | 86.465% |
| pair | 0.9 | 1 | 0 | 4.167% | 95.000% |
| pair | 0.95 | 0 | 0 | 0.000% | N/A |
| pair | 0.99 | 0 | 0 | 0.000% | N/A |

These bounds summarize observed post-selection reference errors, not a guarantee for new models, new providers, or new prompts. The pair has only 24 reference groups.
