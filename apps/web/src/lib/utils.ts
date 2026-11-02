import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function initials(s?: string | null) {
  return (String(s || '?').trim()[0] || '?').toUpperCase()
}
