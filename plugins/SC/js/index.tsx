import { patchYouBar } from './inject'
import { closeSearch } from './search'
import SettingsComponent from './settings'
import { DefaultSettings, setStorage } from './shared'
import { startSpotify } from './spotify'
import type { Settings } from './shared'

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: {
		load: true,
		default: DefaultSettings,
	},
	async start({ cleanup, jsonStorage, plugin }) {
		await jsonStorage.get()
		setStorage(jsonStorage)

		cleanup(() => setStorage(undefined), closeSearch, startSpotify())
		patchYouBar(cleanup, error => plugin.reportError(error))

		// The YouBar is already rendered when the plugin starts late; it cannot be re-patched live.
		if (plugin.startedLate) plugin.requireReload()
	},
	SettingsComponent,
})
