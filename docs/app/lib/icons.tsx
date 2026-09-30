import { Binary, BookOpen, Boxes, Braces, Cloud, Code, Database, FlaskConical, Globe, Network, Palette, Rocket, ScanSearch, Server, ShieldCheck, Terminal, Workflow } from 'lucide-react'
import type { ReactNode } from 'react'

/** Icons that `icon:` in frontmatter and meta.json may name; a small map keeps the rest of lucide out of the bundle. */
export const icons: Record<string, ReactNode> = {
  Binary: <Binary />,
  BookOpen: <BookOpen />,
  Boxes: <Boxes />,
  Braces: <Braces />,
  Cloud: <Cloud />,
  Code: <Code />,
  Database: <Database />,
  FlaskConical: <FlaskConical />,
  Globe: <Globe />,
  Network: <Network />,
  Palette: <Palette />,
  Rocket: <Rocket />,
  ScanSearch: <ScanSearch />,
  Server: <Server />,
  ShieldCheck: <ShieldCheck />,
  Terminal: <Terminal />,
  Workflow: <Workflow />,
}
