/**
 * Legacy string-only name formatter.
 *
 * Retained for call sites that only have a raw name string and no specialty
 * context. New code should prefer `formatProviderName` from `providerTitle.ts`,
 * which derives the title from the provider's specialty.
 *
 * This still normalizes by stripping any leading honorific so a name can never
 * be double-prefixed, and it keeps the historical `fallback` / `withPrefix`
 * options.
 *
 * Examples:
 *   formatDoctorName("John Doe") => "Dr. John Doe"
 *   formatDoctorName("Dr. John Doe") => "Dr. John Doe"
 *   formatDoctorName("Dr John Doe") => "Dr. John Doe"
 *   formatDoctorName(null) => "Doctor"
 *   formatDoctorName(undefined, { fallback: 'your doctor' }) => "your doctor"
 */

import {
  DEFAULT_PROVIDER_TITLE,
  stripProviderHonorific
} from './providerTitle.js'

export function formatDoctorName(
  fullName?: string | null,
  options?: { fallback?: string; withPrefix?: boolean }
): string {
  const fallback = options?.fallback ?? 'Doctor'
  const withPrefix = options?.withPrefix ?? true

  const name = stripProviderHonorific(fullName)
  if (!name || name === 'undefined' || name === 'null') {
    return fallback
  }

  return withPrefix ? `${DEFAULT_PROVIDER_TITLE} ${name}` : name
}

/**
 * Returns a friendly greeting for doctors, e.g.:
 *   getDoctorGreeting("John Doe") => "Hello Dr. John Doe,"
 *   getDoctorGreeting(null) => "Hello Doctor,"
 */
export function getDoctorGreeting(fullName?: string | null, greeting = 'Hello'): string {
  const formatted = formatDoctorName(fullName, { fallback: 'Doctor' })
  return `${greeting} ${formatted},`
}
