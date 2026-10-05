import { CircleCheck, Star } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { answerStarPrompt, REPOSITORY_URL, starPromptAllowed, type StarAnswer } from '@/lib/star'

/** Shows `title` with a Star request below it; a plain toast after a Star, or for a week after a decline. */
export function toastWithStar(title: string, description: string, kind: 'success' | 'message') {
  if (!starPromptAllowed()) {
    if (kind === 'success') toast.success(title)
    else toast(title)
    return
  }
  toast.custom(id => <StarToast id={id} title={title} description={description} success={kind === 'success'} />, { duration: 10000 })
}

function StarToast({ id, title, description, success }: { id: string | number; title: string; description: string; success: boolean }) {
  const { t } = useI18n()
  const close = (answer?: StarAnswer) => {
    if (answer) answerStarPrompt(answer)
    toast.dismiss(id)
  }
  return (
    <div className="fp-star-toast">
      <div className="flex gap-2">
        {success && <CircleCheck className="mt-px size-4 shrink-0" aria-hidden="true" />}
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-medium">{title}</p>
          <p className="text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => close('declined')}>{t('star.decline')}</Button>
        <Button variant="ghost" size="sm" onClick={() => close()}>{t('star.dismiss')}</Button>
        <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" className="fp-star-link" data-size="sm" aria-label={t('app.star')} onClick={() => close('starred')}>
          <Star className="size-3.5" aria-hidden="true" />Star
        </a>
      </div>
    </div>
  )
}
