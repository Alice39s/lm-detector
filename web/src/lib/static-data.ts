import { decompress } from 'fzstd'

type Manifest = Record<string, string[]>

let manifestLoading: Promise<Manifest> | undefined

async function readResponse(url: string): Promise<Response> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('静态参考数据加载失败，请刷新页面后重试。')
  return response
}

export async function readStaticData(name: string): Promise<string> {
  const base = `${import.meta.env.BASE_URL}data/`
  const manifest = await (manifestLoading ??= readResponse(`${base}manifest.json`)
    .then(response => response.json() as Promise<Manifest>)
    .catch(error => { manifestLoading = undefined; throw error }))
  const names = manifest[name]
  if (!names?.length) throw new Error('静态参考数据清单不完整，请刷新页面后重试。')

  const parts = await Promise.all(names.map(async part =>
    new Uint8Array(await (await readResponse(`${base}chunks/${part}`)).arrayBuffer())))
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const compressed = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    compressed.set(part, offset)
    offset += part.length
  }
  return new TextDecoder().decode(decompress(compressed))
}
