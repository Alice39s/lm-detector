/** Export evaluation groups with the frozen product baseline; no requests or fits. */
const entry = import.meta.dir + '/source/research/studies/sequence-generalization/export-evaluation.ts'
const child = Bun.spawn(['bun', entry], {stdout: 'inherit', stderr: 'inherit'})
const status = await child.exited
if (status) throw new Error(`Evaluation export failed with exit ${status}`)
