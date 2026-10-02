import bankJson from '../../../data/tokenizer_bank.json'
import { assertTokenizerBank, type TokenizerBank, type TokenizerClass } from '@fingerpoint/shared/tokenizer-bank'
import { useI18n } from 'fumadocs-ui/contexts/i18n'
import defaultMdxComponents from 'fumadocs-ui/mdx'

// The scrolling wrapper that Markdown tables get, so wide tables scroll instead of widening the page.
const { table: Table } = defaultMdxComponents

function checked(value: unknown): TokenizerBank {
  assertTokenizerBank(value)
  return value
}
const bank = checked(bankJson)

const text = {
  zh: { lab: '实验室', series: '系列', members: '开源分词器', aliases: '别名', pattern: '型号匹配', vendor: '厂商', klass: '分词器类', unpublished: '未公开', count: '{n} 个' },
  en: { lab: 'Lab', series: 'Series', members: 'Open tokenizers', aliases: 'Aliases', pattern: 'Model pattern', vendor: 'Vendor', klass: 'Class', unpublished: 'Not published', count: '{n}' },
}

const byLab = new Map<string, TokenizerClass[]>()
for (const klass of bank.classes) byLab.set(klass.lab_name, [...byLab.get(klass.lab_name) ?? [], klass])
const classNames = new Map(bank.classes.map(klass => [klass.id, klass]))

function seriesName(klass: TokenizerClass, locale: string) {
  return locale === 'zh' ? klass.series_zh : klass.series
}

/** The tokenizer classes of `data/tokenizer_bank.json`, grouped by lab, so the page always matches the shipped bank. */
export default function TokenizerClassesTable({ view = 'classes' }: { view?: 'classes' | 'models' }) {
  const { locale = 'zh' } = useI18n()
  const t = locale === 'en' ? text.en : text.zh
  if (view === 'models') {
    return (
      <Table>
        <thead className="whitespace-nowrap"><tr><th>{t.pattern}</th><th>{t.vendor}</th><th>{t.klass}</th></tr></thead>
        <tbody>
          {bank.api_models.map(model => {
            const klass = model.class ? classNames.get(model.class) : undefined
            return (
              <tr key={model.pattern}>
                <td><code>{model.pattern}</code></td>
                <td>{model.vendor}</td>
                <td>{klass ? seriesName(klass, locale) : t.unpublished}</td>
              </tr>
            )
          })}
        </tbody>
      </Table>
    )
  }
  return (
    <Table>
      <thead className="whitespace-nowrap"><tr><th>{t.lab}</th><th>{t.series}</th><th>{t.members}</th><th>{t.aliases}</th></tr></thead>
      <tbody>
        {[...byLab].flatMap(([lab, classes]) => classes.map((klass, index) => (
          <tr key={klass.id}>
            {index === 0 && <td rowSpan={classes.length}>{lab}</td>}
            <td>
              {seriesName(klass, locale)}
              <br />
              <code>{klass.id}</code>
            </td>
            <td>
              <details>
                <summary>{t.count.replace('{n}', String(klass.members.length))}</summary>
                <ul>{klass.members.map(member => <li key={member}><code>{member}</code></li>)}</ul>
              </details>
            </td>
            <td>{klass.aliases.join(', ') || '—'}</td>
          </tr>
        )))}
      </tbody>
    </Table>
  )
}
