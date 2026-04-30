export class ChargesService {
  calculateConsultationFee (consultationFee: number) {
    const percent = 30
    const doxahealthFee = (consultationFee * percent) / 100

    return {
      percent,
      doxahealthFee,
      total: consultationFee,
      consultationFee: consultationFee - doxahealthFee
    }
  }
}

export const chargesService = new ChargesService()
