# 全库候选前两名的局部判别重排

基线 Ensemble：564/636；选择后：576/636。选择候选：`frequency_shrink0.3_gate0.25`。参数选择只使用全部模型的留环境开发预测。

每组先由全库排名器选择前两名。两标签的训练回答单独拟合缩放和收缩协方差，再合并三条回答的线性判别方向。序列版添加 44 个致密顺序统计；位置版使用四段 × 16 值桶的联合分布。局部判别只可交换前两名的排名分数，因此不会凭局部训练人为提高分数幅度。

12 个外折排除同挑战、环境前缀变体、精确原文和数字序列。预处理只用外折训练。当前 OOF 用于筛选，结果属于开发估计。外部配对集和冻结 holdout 尚未打开。

| 方法 | 三回答命中 | Top-1 |
|---|---:|---:|
| frequency_shrink0.1_gate0.25 | 576/636 | 0.906 |
| frequency_shrink0.1_gate0.5 | 573/636 | 0.901 |
| frequency_shrink0.1_gate1 | 573/636 | 0.901 |
| frequency_shrink0.1_gate10 | 572/636 | 0.899 |
| frequency_shrink0.3_gate0.25 | 576/636 | 0.906 |
| frequency_shrink0.3_gate0.5 | 573/636 | 0.901 |
| frequency_shrink0.3_gate1 | 573/636 | 0.901 |
| frequency_shrink0.3_gate10 | 572/636 | 0.899 |
| frequency_shrink0.7_gate0.25 | 575/636 | 0.904 |
| frequency_shrink0.7_gate0.5 | 571/636 | 0.898 |
| frequency_shrink0.7_gate1 | 571/636 | 0.898 |
| frequency_shrink0.7_gate10 | 570/636 | 0.896 |
| frequency_order_shrink0.1_gate0.25 | 574/636 | 0.903 |
| frequency_order_shrink0.1_gate0.5 | 573/636 | 0.901 |
| frequency_order_shrink0.1_gate1 | 572/636 | 0.899 |
| frequency_order_shrink0.1_gate10 | 572/636 | 0.899 |
| frequency_order_shrink0.3_gate0.25 | 575/636 | 0.904 |
| frequency_order_shrink0.3_gate0.5 | 573/636 | 0.901 |
| frequency_order_shrink0.3_gate1 | 571/636 | 0.898 |
| frequency_order_shrink0.3_gate10 | 571/636 | 0.898 |
| frequency_order_shrink0.7_gate0.25 | 575/636 | 0.904 |
| frequency_order_shrink0.7_gate0.5 | 573/636 | 0.901 |
| frequency_order_shrink0.7_gate1 | 571/636 | 0.898 |
| frequency_order_shrink0.7_gate10 | 571/636 | 0.898 |
| position4_shrink0.1_gate0.25 | 565/636 | 0.888 |
| position4_shrink0.1_gate0.5 | 562/636 | 0.884 |
| position4_shrink0.1_gate1 | 546/636 | 0.858 |
| position4_shrink0.1_gate10 | 522/636 | 0.821 |
| position4_shrink0.3_gate0.25 | 569/636 | 0.895 |
| position4_shrink0.3_gate0.5 | 565/636 | 0.888 |
| position4_shrink0.3_gate1 | 556/636 | 0.874 |
| position4_shrink0.3_gate10 | 538/636 | 0.846 |
| position4_shrink0.7_gate0.25 | 572/636 | 0.899 |
| position4_shrink0.7_gate0.5 | 570/636 | 0.896 |
| position4_shrink0.7_gate1 | 556/636 | 0.874 |
| position4_shrink0.7_gate10 | 541/636 | 0.851 |
