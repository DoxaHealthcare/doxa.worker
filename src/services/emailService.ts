import { SentMessageInfo } from 'nodemailer'
import { parseTemplate } from '../utils/templateParser.js'
import logger from '../utils/logger.js'
import { Resend } from 'resend'
import { EmailFrom } from '../utils/contant/index.js'

export const sendEmail = async (
  to: string,
  subject: string,
  templateName: string,
  placeholders: { [key: string]: string },
  from: EmailFrom = 'noreply'
): Promise<SentMessageInfo> => {
  logger.info('Starting email send process', {
    to,
    subject,
    templateName,
    placeholderKeys: Object.keys(placeholders)
  })

  try {
    logger.debug('Parsing email template', { templateName })
    const htmlContent = parseTemplate(templateName, placeholders)

    if (!htmlContent) {
      logger.error('Template parsing failed', { templateName })
      throw new Error(`Template ${templateName} could not be parsed`)
    }
    logger.debug('Template parsed successfully', { templateName })

    const apiKey = process.env.RESEND_API_KEY
    const domain = process.env.DOMAIN_NAME
    const fromEmail = process.env.EMAIL_FROM && process.env.EMAIL_FROM.includes('@')
      ? process.env.EMAIL_FROM
      : `${from}@${domain}`

    const fromName = process.env.EMAIL_FROM_NAME || 'Doxa Healthcare'

    logger.debug('Email configuration', {
      fromEmail,
      fromName,
      domain,
      hasApiKey: !!apiKey,
      apiKeyPrefix: apiKey ? `${apiKey.substring(0, 5)}...` : 'none'
    })

    if (!apiKey) {
      logger.error('RESEND_API_KEY is not set in environment variables')
      throw new Error('Missing RESEND_API_KEY')
    }

    if (!fromEmail) {
      logger.error(
        'EMAIL_FROM is not set. Use an address on your verified domain'
      )
      throw new Error('Missing EMAIL_FROM')
    }

    if (!fromEmail.includes('@')) {
      logger.error(
        `EMAIL_FROM must be a full email address like noreply@${process.env.DOMAIN_NAME}`,
        {
          provided: fromEmail
        }
      )
      throw new Error('Invalid EMAIL_FROM value: expected an email address')
    }

    const resend = new Resend(apiKey)

    const { data, error } = await resend.emails.send({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject,
      html: htmlContent
    })

    if (error) {
      logger.error('Resend API error:', { error, to, subject });
      return { success: false, error };
    }

    logger.info('Email sent successfully via Resend', { id: data?.id, to });

    return {
      messageId: data?.id,
      success: true
    }
  } catch (error: any) {
    logger.error('Error in sendEmail service:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      command: error.command,
      responseCode: error.responseCode,
      to,
      subject,
      templateName
    })
  }
}
