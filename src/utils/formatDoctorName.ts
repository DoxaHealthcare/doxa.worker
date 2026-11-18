/**
 * Normalizes a doctor's name for display across emails, notifications, and logs.
 * Ensures titles like "Dr." are not duplicated and provides a clean fallback.
 *
 * Examples:
 *   formatDoctorName("John Doe") => "Dr. John Doe"
 *   formatDoctorName("Dr. John Doe") => "Dr. John Doe"
 *   formatDoctorName("Dr John Doe") => "Dr. John Doe"
 *   formatDoctorName(null) => "Doctor"
 *   formatDoctorName(undefined, { fallback: 'your doctor' }) => "your doctor"
 */
export function formatDoctorName(
  fullName?: string | null,
  options?: { fallback?: string; withPrefix?: boolean }
): string {
  const fallback = options?.fallback ?? 'Doctor'
  const withPrefix = options?.withPrefix ?? true

  if (!fullName || typeof fullName !== 'string') {
    return fallback
  }

  const trimmed = fullName.trim()
  if (!trimmed || trimmed === 'undefined' || trimmed === 'null') {
    return fallback
  }

  // Remove existing "Dr." or "Dr" prefix (case insensitive) to normalize
  const stripped = trimmed.replace(/^dr\.?\s+/i, '').trim()
  if (!stripped) {
    return fallback
  }

  if (withPrefix) {
    return `Dr. ${stripped}`
  }

  return stripped
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
