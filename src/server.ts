import { createServerEntry } from '@tanstack/react-start/server-entry'
import { defaultStreamHandler, createStartHandler } from '@tanstack/react-start/server'
import { startHotboardScheduler } from './server/hotboard-scheduler'

startHotboardScheduler()

const fetch = createStartHandler(defaultStreamHandler)

export default createServerEntry({ fetch })
