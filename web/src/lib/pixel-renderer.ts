import { pixelEffects, pixelPrelude, type PixelEffect } from './pixel-effects'

export type { PixelEffect }

export interface PixelViewHandle {
  /** 宿主 color 变化后重新取色。 */
  refresh(): void
  dispose(): void
}

type Rgba = [number, number, number, number]

interface View {
  host: HTMLElement
  canvas: HTMLCanvasElement
  context: CanvasRenderingContext2D
  effect: PixelEffect
  cell: number
  seed: number
  columns: number
  rows: number
  visible: boolean
  colorSource: string
  color: Rgba
  dirty: boolean
}

interface Program {
  program: WebGLProgram
  res: WebGLUniformLocation | null
  time: WebGLUniformLocation | null
  seed: WebGLUniformLocation | null
  color: WebGLUniformLocation | null
}

const FPS = 24
const PLAYBACK_RATE = 0.5
/** 减少动效时所有视图停在同一时刻的静态帧。 */
const STILL_TIME = 3.7
const vertexSource = 'attribute vec2 a_pos; void main() { gl_Position = vec4(a_pos, 0., 1.); }'

const colorProbe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
const colorCache = new Map<string, Rgba>()

/** 用 2D 画布把任意 CSS 颜色（含 oklch、color-mix 结果）转换为 sRGB。 */
function parseColor(value: string): Rgba {
  const cached = colorCache.get(value)
  if (cached) return cached
  let color: Rgba = [0, 0, 0, 0]
  if (colorProbe) {
    colorProbe.clearRect(0, 0, 1, 1)
    colorProbe.fillStyle = '#0000'
    colorProbe.fillStyle = value
    colorProbe.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data
    color = [r / 255, g / 255, b / 255, a / 255]
  }
  colorCache.set(value, color)
  return color
}

/** 所有像素装饰共用一个离屏 WebGL 上下文，避免多个画布触及浏览器的上下文数量上限。 */
class PixelRenderer {
  private readonly views = new Map<Element, View>()
  private readonly programs = new Map<PixelEffect, Program | null>()
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly start = performance.now()
  private vertex: WebGLShader | null = null
  private lost = false
  private frame = 0
  private lastDraw = -Infinity

  private readonly resize = new ResizeObserver(entries => {
    for (const entry of entries) {
      const view = this.views.get(entry.target)
      if (!view) continue
      const columns = Math.ceil(entry.contentRect.width / view.cell)
      const rows = Math.ceil(entry.contentRect.height / view.cell)
      if (columns === view.columns && rows === view.rows) continue
      view.columns = columns
      view.rows = rows
      view.dirty = true
      view.canvas.width = columns
      view.canvas.height = rows
      view.canvas.style.width = `${columns * view.cell}px`
      view.canvas.style.height = `${rows * view.cell}px`
    }
    this.schedule()
  })

  private readonly intersection = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const view = this.views.get(entry.target)
      if (!view) continue
      view.visible = entry.isIntersecting
      view.dirty ||= entry.isIntersecting
    }
    this.schedule()
  }, { rootMargin: '64px' })

  static create() {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' })
    return gl ? new PixelRenderer(canvas, gl) : null
  }

  private constructor(private readonly canvas: HTMLCanvasElement, private readonly gl: WebGLRenderingContext) {
    canvas.width = 256
    canvas.height = 64
    this.setup()
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault()
      this.lost = true
      this.programs.clear()
      cancelAnimationFrame(this.frame)
      this.frame = 0
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false
      this.setup()
      this.invalidate(false)
    })
    new MutationObserver(() => this.invalidate(true)).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    this.motion.addEventListener('change', () => this.invalidate(false))
    document.addEventListener('visibilitychange', () => this.schedule())
  }

  attach(host: HTMLElement, effect: PixelEffect, cell: number): PixelViewHandle | null {
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) return null
    canvas.width = 0
    canvas.height = 0
    host.append(canvas)
    const view: View = { host, canvas, context, effect, cell, seed: Math.random() * 64, columns: 0, rows: 0, visible: false, colorSource: '', color: [0, 0, 0, 0], dirty: true }
    this.views.set(host, view)
    this.readColor(view)
    this.resize.observe(host)
    this.intersection.observe(host)
    return {
      refresh: () => {
        if (this.readColor(view)) this.schedule()
      },
      dispose: () => {
        this.resize.unobserve(host)
        this.intersection.unobserve(host)
        this.views.delete(host)
        canvas.remove()
      },
    }
  }

  private setup() {
    const { gl } = this
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.vertex = this.compileShader(gl.VERTEX_SHADER, vertexSource)
  }

  /** 返回颜色是否变化；变化时标记重绘。 */
  private readColor(view: View) {
    const source = getComputedStyle(view.host).color
    if (source === view.colorSource) return false
    view.colorSource = source
    view.color = parseColor(source)
    view.dirty = true
    return true
  }

  private invalidate(recolor: boolean) {
    for (const view of this.views.values()) {
      if (recolor) this.readColor(view)
      view.dirty = true
    }
    this.schedule()
  }

  private schedule() {
    if (this.frame || this.lost || document.hidden) return
    const animate = !this.motion.matches
    for (const view of this.views.values()) {
      if (view.visible && view.columns && view.rows && (animate || view.dirty)) {
        this.frame = requestAnimationFrame(now => this.tick(now))
        return
      }
    }
  }

  private tick(now: number) {
    this.frame = 0
    const animate = !this.motion.matches
    const due = animate && now - this.lastDraw >= 1000 / FPS - 1
    if (due) this.lastDraw = now
    const time = animate ? ((now - this.start) / 1000 * PLAYBACK_RATE) % 3600 : STILL_TIME
    for (const view of this.views.values()) {
      if (view.visible && view.columns && view.rows && (due || view.dirty)) this.draw(view, time)
    }
    this.schedule()
  }

  private draw(view: View, time: number) {
    const program = this.program(view.effect)
    view.dirty = false
    if (!program) return
    const { gl, canvas } = this
    if (canvas.width < view.columns) canvas.width = view.columns
    if (canvas.height < view.rows) canvas.height = view.rows
    gl.viewport(0, 0, view.columns, view.rows)
    gl.useProgram(program.program)
    gl.uniform2f(program.res, view.columns, view.rows)
    gl.uniform1f(program.time, time)
    gl.uniform1f(program.seed, view.seed)
    gl.uniform4fv(program.color, view.color)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    view.context.clearRect(0, 0, view.columns, view.rows)
    // WebGL 原点在左下角，视口位于绘图缓冲的底部。
    view.context.drawImage(canvas, 0, canvas.height - view.rows, view.columns, view.rows, 0, 0, view.columns, view.rows)
  }

  private program(effect: PixelEffect) {
    const cached = this.programs.get(effect)
    if (cached !== undefined) return cached
    const { gl } = this
    const fragment = this.compileShader(gl.FRAGMENT_SHADER, pixelPrelude + pixelEffects[effect])
    const program = gl.createProgram()
    let result: Program | null = null
    if (this.vertex && fragment && program) {
      gl.attachShader(program, this.vertex)
      gl.attachShader(program, fragment)
      gl.bindAttribLocation(program, 0, 'a_pos')
      gl.linkProgram(program)
      if (gl.getProgramParameter(program, gl.LINK_STATUS)) {
        result = {
          program,
          res: gl.getUniformLocation(program, 'u_res'),
          time: gl.getUniformLocation(program, 'u_time'),
          seed: gl.getUniformLocation(program, 'u_seed'),
          color: gl.getUniformLocation(program, 'u_color'),
        }
      } else if (!gl.isContextLost()) {
        console.error(`pixel shader "${effect}" link failed`, gl.getProgramInfoLog(program))
      }
    }
    this.programs.set(effect, result)
    return result
  }

  private compileShader(type: number, source: string) {
    const { gl } = this
    const shader = gl.createShader(type)
    if (!shader) return null
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
    if (!gl.isContextLost()) console.error('pixel shader compile failed', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
}

let renderer: PixelRenderer | null | undefined

/** 在宿主元素内挂载一个像素着色器画布；不支持 WebGL 时返回 null，装饰保持透明。 */
export function attachPixelView(host: HTMLElement, effect: PixelEffect, cell: number) {
  if (renderer === undefined) renderer = PixelRenderer.create()
  return renderer?.attach(host, effect, cell) ?? null
}
