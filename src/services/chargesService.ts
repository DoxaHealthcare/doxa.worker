import { ServiceResponse } from '../../custom-types.js'

export class ChargesService {
  calculateConsultationFee(consultationFee: number): ServiceResponse {
    const percent = 30
    const doxahealthFee = (consultationFee * percent) / 100

    return {
      success: true,
      data: {
        percent,
        doxahealthFee,
        total: consultationFee,
        consultationFee: consultationFee - doxahealthFee
      },
      message: 'Consultation fee calculated successfully',
      code: 200
    }
  }
}

export const chargesService = new ChargesService()
