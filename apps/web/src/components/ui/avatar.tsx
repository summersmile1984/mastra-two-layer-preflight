import { cn, initials } from '@/lib/utils'

const roleClass: Record<string, string> = {
  butler: 'bg-av-butler text-av-butler-fg',
  bot: 'bg-av-butler text-av-butler-fg',
  me: 'bg-av-user text-av-user-fg',
  user: 'bg-indigo-100 text-indigo-700',
  expert: 'bg-av-expert text-av-expert-fg',
}

export function Avatar({
  name,
  role = 'user',
  size = 'md',
  className,
}: {
  name?: string | null
  role?: keyof typeof roleClass | string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const sz = size === 'sm' ? 'h-[26px] w-[26px] text-[11px]' : size === 'lg' ? 'h-8 w-8 text-sm' : 'h-8 w-8 text-[13px]'
  return (
    <div
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[10px] font-semibold tracking-tight',
        sz,
        roleClass[role] || roleClass.user,
        className,
      )}
      aria-hidden
    >
      {initials(name)}
    </div>
  )
}
