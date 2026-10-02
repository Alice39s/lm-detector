import type { Nodes, Root, TableCell } from 'mdast'
import type {} from 'mdast-util-to-hast'
import { visit } from 'unist-util-visit'

/** The widest cell that still makes a label column: 8 Chinese characters or 16 Latin ones. */
const LABEL_WIDTH = 16
const WIDE = /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u

function text(node: Nodes): string {
  if ('value' in node) return node.value
  return 'children' in node ? node.children.map(text).join('') : ''
}

function width(node: Nodes) {
  let units = 0
  for (const char of text(node)) units += WIDE.test(char) ? 2 : 1
  return units
}

function noWrap(cell: TableCell) {
  cell.data = { ...cell.data, hProperties: { ...cell.data?.hProperties, className: ['whitespace-nowrap'] } }
}

/**
 * Keeps table headers and short columns of Markdown tables on one line. Automatic table layout gives almost all spare
 * width to the column with the longest text and shrinks the others to their narrowest word; Chinese breaks between
 * any two characters, so a header such as 位置 would stack one character per line.
 */
export function remarkLabelColumns() {
  return (tree: Root) => {
    visit(tree, 'table', table => {
      const [head, ...body] = table.children
      if (!head) return
      head.children.forEach(noWrap)
      for (let column = 0; column < head.children.length; column++) {
        const cells = body.flatMap(row => row.children[column] ?? [])
        if (cells.every(cell => width(cell) <= LABEL_WIDTH)) cells.forEach(noWrap)
      }
    })
  }
}
