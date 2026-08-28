import { useAtomValue } from "jotai"
import { useCallback } from "react"
import { appLanguageAtom, translate, type TranslationKey } from "../lib/i18n"

export function useI18n() {
	const language = useAtomValue(appLanguageAtom)
	const t = useCallback((key: TranslationKey) => translate(language, key), [language])
	return { language, t }
}
