import { useRef } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { proxyHost, proxyName } from '@/lib/route'
import type { ProxyConsentRequest, ProxyConsentAnswer } from '@/lib/use-connection-route'

/**
 * Asked just in time, before the first request that needs the proxy. Dismissing sends nothing. "Allow once" lasts
 * for this page session; "Always allow" is remembered per proxy and upstream origin until revoked in the API
 * configuration.
 */
export function ProxyConsentDialog({ request, onAnswer }: { request: ProxyConsentRequest | null; onAnswer: (answer: ProxyConsentAnswer) => void }) {
  const { t } = useI18n()
  const cancel = useRef<HTMLButtonElement>(null)
  const host = request ? new URL(request.origin).host : ''
  const proxy = request ? proxyName(t, request.proxy) : ''
  const custom = request !== null && proxyHost(request.proxy) !== null
  return (
    <Dialog open={request !== null} onOpenChange={open => { if (!open) onAnswer(null) }}>
      <DialogContent initialFocus={cancel} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldAlert className="size-4 text-warning" aria-hidden="true" />{t('proxy.title')}</DialogTitle>
          <DialogDescription>
            {t(request?.reachability === 'unreachable' ? 'proxy.unreachable' : 'proxy.blocked', { host, proxy })}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-muted-foreground">
          <li>{t('proxy.pointKey', { proxy })}</li>
          <li>{t(custom ? 'proxy.pointStorageCustom' : 'proxy.pointStorage')}</li>
          <li>{t('proxy.pointRevoke')}</li>
        </ul>
        <DialogFooter>
          <Button ref={cancel} variant="ghost" onClick={() => onAnswer(null)}>{t('proxy.dismiss')}</Button>
          <Button variant="outline" onClick={() => onAnswer('once')}>{t('proxy.once')}</Button>
          <Button onClick={() => onAnswer('always')}>{t('proxy.always')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
