import {
  Client,
  IntentsBitField,
} from 'discord.js'
import { discordBotService } from '../src/services/discord-bot/index.js'

export const discordClient = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent
  ]
})

discordClient.on('clientReady', () => {
  // eslint-disable-next-line no-console
  console.log(`Discord client logged in as ${discordClient.user?.tag}`)
  discordBotService.registerApprovalButtonsHandler()
  discordBotService.registerDoctorOnboardingHandler()
})
