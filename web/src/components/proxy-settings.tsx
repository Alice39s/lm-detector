import { useState, useSyncExternalStore } from 'react'
import { CloudUpload, FileCode2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { parseOrigins } from '../../../worker/main.js'
import workerConfig from '../../../worker/wrangler.json'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldTitle } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/segmented'
import { useI18n } from '@/i18n'
import { checkProxy, parseProxyEndpoint, proxySetting, routeVersion, setProxySetting, SITE_PROXY, subscribeRoute, type ProxyHealth } from '@/lib/route'
import { DEPLOY_BUTTON_URL, openWorkerPlayground } from '@/lib/worker-deploy'
import { cn } from '@/lib/utils'

type Mode = 'site' | 'worker'

/**
 * Chooses the relay for APIs without browser CORS: this site's proxy or a Worker the user deployed from
 * `worker/main.js`. The choice is global, not part of a profile, because it describes the user's infrastructure.
 */
export function ProxySettings({ disabled }: { disabled: boolean }) {
  const { t } = useI18n()
  useSyncExternalStore(subscribeRoute, routeVersion, routeVersion)
  const { mode, endpoint } = proxySetting()
  const [draft, setDraft] = useState(() => endpoint ?? '')
  // The address last written from this component; a different stored address came from another tab.
  const [written, setWritten] = useState(endpoint)
  if (endpoint !== written) {
    setWritten(endpoint)
    if (endpoint) setDraft(endpoint)
  }
  const [touched, setTouched] = useState(false)
  const [health, setHealth] = useState<{ endpoint: string; result: ProxyHealth } | null>(null)
  const [checking, setChecking] = useState(false)
  const [importing, setImporting] = useState(false)
  // The relay the controls describe; null while the Worker address is empty or incomplete.
  const selected = mode === 'site' ? SITE_PROXY : endpoint
  const invalid = mode === 'worker' && touched && draft.trim() !== '' && selected === null
  const allowed = parseOrigins(workerConfig.vars.ALLOWED_ORIGINS)
  const outsideDefault = !allowed.includes('*') && !allowed.includes(location.origin)

  /** Saves the choice. An empty or invalid address clears the saved one, so no request goes to a stale Worker. */
  function save(next: Mode, address: string) {
    const parsed = parseProxyEndpoint(address)
    setWritten(parsed)
    setProxySetting({ mode: next, endpoint: parsed })
  }

  function edit(value: string) {
    setDraft(value)
    save('worker', value)
  }

  async function check(endpoint: string) {
    setChecking(true)
    try { setHealth({ endpoint, result: await checkProxy(endpoint) }) } finally { setChecking(false) }
  }

  async function importPlayground() {
    setImporting(true)
    try {
      if (await openWorkerPlayground() === 'blocked') toast.error(t('proxy.popupBlocked'))
    } catch {
      toast.error(t('proxy.playgroundFailed'))
    } finally { setImporting(false) }
  }

  const result = selected !== null && health?.endpoint === selected ? health.result : null
  return (
    <Field className="md:col-span-2">
      <FieldContent>
        <FieldTitle>{t('proxy.setting')}</FieldTitle>
        <FieldDescription>{t('proxy.settingHelp')}</FieldDescription>
      </FieldContent>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label={t('proxy.setting')} value={mode} disabled={disabled} onChange={next => save(next, draft)} options={[
          { value: 'site', label: t('proxy.modeSite') },
          { value: 'worker', label: t('proxy.modeWorker') },
        ]} />
        <Button type="button" variant="outline" className="h-9" disabled={disabled || checking || selected === null} onClick={() => { if (selected) void check(selected) }}>
          {checking ? <><Loader2 data-icon="inline-start" className="animate-spin" />{t('proxy.checkingProxy')}</> : t('proxy.check')}
        </Button>
      </div>
      {mode === 'worker' && (
        <Field data-invalid={invalid || undefined}>
          <FieldLabel htmlFor="proxy-worker-url">{t('proxy.workerUrl')}</FieldLabel>
          <Input
            id="proxy-worker-url"
            className="fp-mono h-9"
            value={draft}
            placeholder="https://fingerpoint-api-proxy.example.workers.dev"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? 'proxy-worker-error' : undefined}
            onChange={event => edit(event.target.value)}
            onBlur={() => { setTouched(true); setDraft(current => parseProxyEndpoint(current) ?? current.trim()) }}
          />
          {invalid && <FieldError id="proxy-worker-error">{t('proxy.workerInvalid')}</FieldError>}
        </Field>
      )}
      <p role="status" aria-live="polite" className={cn('text-meta', result === 'ok' ? 'text-success' : 'text-muted-foreground', !result && 'sr-only')}>
        {result && t(`proxy.health.${result}`, { origin: location.origin })}
      </p>
      {mode === 'worker' && (
        <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
          <p className="text-meta font-medium">{t('proxy.deployTitle')}</p>
          <div className="flex flex-wrap gap-2">
            <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={DEPLOY_BUTTON_URL} target="_blank" rel="noopener noreferrer" aria-describedby="proxy-deploy-help">
              <CloudUpload data-icon="inline-start" aria-hidden="true" />{t('proxy.deployButton')}
            </a>
            <Button type="button" variant="outline" size="sm" disabled={disabled || importing} onClick={() => { void importPlayground() }} aria-describedby="proxy-playground-help">
              {importing ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <FileCode2 data-icon="inline-start" aria-hidden="true" />}{t('proxy.playground')}
            </Button>
          </div>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-meta text-muted-foreground">
            <li id="proxy-deploy-help">{t('proxy.deployButtonHelp')}</li>
            <li id="proxy-playground-help">{t('proxy.playgroundHelp')}</li>
            {outsideDefault && <li>{t('proxy.originHint', { allowed: allowed.join(', '), origin: location.origin })}</li>}
          </ul>
        </div>
      )}
    </Field>
  )
}
