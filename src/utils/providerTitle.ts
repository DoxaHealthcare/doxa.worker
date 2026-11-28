/**
 * Provider title resolution.
 *
 * Provider titles ("Dr.", "Therapist", …) are NOT stored inside `fullName`.
 * Names are stored clean and the title is derived at display/send time from:
 *   1. the provider's explicit `titleOverride` (if present), else
 *   2. the default title configured for the provider's specialty, else
 *   3. `DEFAULT_PROVIDER_TITLE`.
 *
 * The runtime source of truth for (2) is the Firestore `specialties`
 * collection (`defaultTitle` per doc). `SPECIALTY_DEFAULT_TITLES` below is a
 * code-side fallback used when the collection is unavailable so a title is
 * always produced.
 */

/** Used when a specialty has no configured default (decision D4). */
export const DEFAULT_PROVIDER_TITLE = 'Dr.'

/**
 * Fallback specialty -> default title map. Mirrors the `specialties`
 * collection; keep both in sync when adding specialties.
 */
export const SPECIALTY_DEFAULT_TITLES: Record<string, string> = {
  'General Practitioner': 'Dr.',
  Cardiologist: 'Dr.',
  Dermatologist: 'Dr.',
  Pediatrician: 'Dr.',
  'Obstetrician & Gynecologist': 'Dr.',
  Orthopedist: 'Dr.',
  Psychiatrist: 'Dr.',
  Surgeon: 'Dr.',
  Neurologist: 'Dr.',
  'Clinical Psychologist': 'Dr.'
}

/** Resolved specialty -> title map. Values may be `null` to mean "no title". */
export type TitleConfig = Record<string, string | null | undefined>

export type ProviderNameInput = {
  fullName?: string | null
  name?: string | null
  specialty?: string | null
  titleOverride?: string | null
  careerDetails?: { specialty?: string | null } | null
  [key: string]: any
}

/**
 * Honorifics that may appear at the start of a stored name from before the
 * clean-name migration. Stripped so a name can never render as "Dr. Dr. Jane".
 */
const LEADING_HONORIFIC = /^(dr|prof|mr|mrs|ms|miss|therapist)\.?(?:\s+|$)/i

/**
 * Removes a single leading honorific from a stored name.
 */
export function stripProviderHonorific(name?: string | null): string {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return ''
  return trimmed.replace(LEADING_HONORIFIC, '').trim()
}

/** Resolves the provider's specialty, preferring `careerDetails.specialty`. */
function resolveSpecialty(input?: ProviderNameInput | null): string {
  const specialty = input?.careerDetails?.specialty || input?.specialty || ''
  return String(specialty).trim()
}

/**
 * Resolves the title for a provider. An explicit `titleOverride` always wins;
 * an empty-string override intentionally yields no title.
 */
export function resolveProviderTitle(
  input?: ProviderNameInput | null,
  config: TitleConfig = SPECIALTY_DEFAULT_TITLES,
  fallback: string = DEFAULT_PROVIDER_TITLE
): string {
  if (typeof input?.titleOverride === 'string') {
    return input.titleOverride.trim()
  }

  const specialty = resolveSpecialty(input)
  if (specialty && config && Object.prototype.hasOwnProperty.call(config, specialty)) {
    const configured = config[specialty]
    // A present-but-nullish value means "no title" for this specialty.
    if (configured === null || configured === undefined) return ''
    return String(configured).trim()
  }

  return fallback
}

/**
 * Formats a provider's display name as "<title> <clean name>".
 * Returns the fallback when there is no usable name.
 */
export function formatProviderName(
  input?: ProviderNameInput | null,
  config: TitleConfig = SPECIALTY_DEFAULT_TITLES,
  fallback: string = DEFAULT_PROVIDER_TITLE
): string {
  const rawName = input?.fullName ?? input?.name
  const name = stripProviderHonorific(rawName)
  if (!name || name === 'undefined' || name === 'null') return fallback

  const title = resolveProviderTitle(input, config, fallback)
  return [title, name].filter(Boolean).join(' ')
}
