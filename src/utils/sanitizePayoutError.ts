/**
 * Sanitizes payout error text before it is logged, stored or posted to
 * Discord. Strips email addresses and long digit sequences (account
 * numbers, card numbers, phone numbers) and truncates the result.
 */
export const sanitizePayoutError = (
  input: unknown,
  maxLength = 200
): string => {
  const raw =
    input instanceof Error ? input.message : String(input ?? 'unknown error')
  const cleaned = raw
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    // Digit groups of 9+ digits total, allowing spaces/dashes/parens/dots
    // as separators (phones like "0803 123 4567", "+234-803-123-4567",
    // cards and account numbers). Commas are NOT separators so amounts
    // like "15,000" and short numbers like "500" survive.
    .replace(/\+?\d(?:[\d\s().-]*\d)?/g, match =>
      match.replace(/\D/g, '').length >= 9 ? '[number]' : match
    )
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength)}…`
    : cleaned
}
