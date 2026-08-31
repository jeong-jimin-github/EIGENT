import { useEffect } from "react"
import { useI18n } from "../hooks/use-i18n"

const ko: Record<string, string> = {
	"Servers": "서버",
	"Connect to local or remote OpenCode servers": "로컬 또는 원격 OpenCode 서버에 연결합니다",
	"Active": "활성",
	"Auto-managed local server": "자동 관리 로컬 서버",
	"Connect": "연결",
	"Edit": "편집",
	"Remove": "제거",
	"Save": "저장",
	"Hostname": "호스트 이름",
	"Port": "포트",
	"Password": "비밀번호",
	"Password set": "비밀번호 설정됨",
	"mDNS Discovery": "mDNS 검색",
	"mDNS Domain": "mDNS 도메인",
	"Discovered on Network": "네트워크에서 검색됨",
	"Name": "이름",
	"Username": "사용자 이름",
	"Cancel": "취소",
	"Add": "추가",
	"Done": "완료",
	"Retry": "재시도",
	"Install": "설치",
	"Uninstall": "제거",
	"Check": "확인",
	"Checking...": "확인 중...",
	"Not found": "찾을 수 없음",
	"Restore": "복원",
	"Setup": "초기 설정",
	"About": "정보",
	"Providers": "프로바이더",
	"Connected": "연결됨",
	"Available": "사용 가능",
	"Worktrees": "워크트리",
	"Overview": "개요",
	"No worktrees": "워크트리가 없습니다",
	"Active Worktrees": "활성 워크트리",
	"Notifications": "알림",
	"Never": "사용 안 함",
	"Only when unfocused": "창이 비활성화됐을 때만",
	"Always": "항상",
	"Web Push": "웹 푸시",
	"Automations": "자동화",
	"Filter": "필터",
	"New": "새로 만들기",
	"Scheduled": "예약됨",
	"Completed": "완료됨",
	"Archived": "보관됨",
	"No automations yet": "자동화가 없습니다",
	"Create Automation": "자동화 만들기",
	"Edit automation": "자동화 편집",
	"Run now": "지금 실행",
	"Paused": "일시중지됨",
	"No runs yet": "실행 기록이 없습니다",
	"Run history": "실행 기록",
	"Run not found": "실행 기록을 찾을 수 없습니다",
	"Schedule": "일정",
	"Choose a schedule": "일정을 선택하세요",
	"Custom": "사용자 지정",
	"Type": "유형",
	"Daily": "매일",
	"Interval": "간격",
	"Every": "매",
	"at": "시간",
	"on": "요일",
	"minutes": "분",
	"hours": "시간",
	"Next:": "다음:",
	"Projects": "프로젝트",
	"Search projects...": "프로젝트 검색...",
	"No projects found": "프로젝트를 찾을 수 없습니다",
	"Add custom path": "사용자 지정 경로 추가",
	"Browse for folder": "폴더 찾아보기",
	"Prompt": "프롬프트",
	"Agent & model": "에이전트 및 모델",
	"Project Tools": "프로젝트 도구",
	"Files": "파일",
	"Terminal": "터미널",
	"Processes": "프로세스",
	"Browser": "브라우저",
	"Desktop": "데스크톱",
	"Copy": "복사",
	"Stop": "중지",
	"Undo": "실행 취소",
	"Redo": "다시 실행",
	"Fork": "포크",
	"Delete": "삭제",
	"Approve": "승인",
	"Reject": "거부",
	"Submit": "제출",
	"Dismiss": "닫기",
	"Show browser panel": "브라우저 패널 열기",
	"Hide browser panel": "브라우저 패널 닫기",
	"Show changes panel": "변경사항 패널 열기",
	"Hide changes panel": "변경사항 패널 닫기",
	"Backup & Restore": "백업 및 복원",
	"Export backup": "백업 내보내기",
	"Import backup": "백업 가져오기",
	"Export": "내보내기",
	"Import": "가져오기",
	"Import & Restart": "가져온 뒤 재시작",
}

const phraseKo: Array<[RegExp, string]> = [
	[/^Started (.+)$/i, "$1 시작"],
	[/^(\d+) runs?$/i, "$1회 실행"],
	[/^Every (\d+) minutes$/i, "$1분마다"],
	[/^Every (\d+) hours$/i, "$1시간마다"],
]

const originalText = new Map<Text, string>()
const originalAttributes = new Map<Element, Map<string, string>>()

function translateValue(value: string): string {
	const trimmed = value.trim()
	const direct = ko[trimmed]
	if (direct) return value.replace(trimmed, direct)
	for (const [pattern, replacement] of phraseKo) {
		if (pattern.test(trimmed)) return value.replace(trimmed, trimmed.replace(pattern, replacement))
	}
	return value
}

function skipElement(element: Element): boolean {
	return Boolean(
		element.closest(
			"pre, code, textarea, [contenteditable='true'], [data-no-legacy-i18n], article",
		),
	)
}

function shouldTranslateText(text: Text): boolean {
	const parent = text.parentElement
	if (!parent || skipElement(parent)) return false
	const hash = window.location.hash
	const broad = hash.includes("/settings/") || hash.includes("/automations") || hash.includes("/tools")
	if (broad) return true
	return Boolean(
		parent.closest(
			"button, label, h1, h2, h3, [role='menuitem'], [role='tab'], [role='option'], [role='tooltip']",
		),
	)
}

function translateTree(root: Node): void {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
	let current: Node | null = root.nodeType === Node.TEXT_NODE ? root : walker.nextNode()
	while (current) {
		const text = current as Text
		if (shouldTranslateText(text)) {
			const next = translateValue(text.data)
			if (next !== text.data) {
				if (!originalText.has(text)) originalText.set(text, text.data)
				text.data = next
			}
		}
		current = walker.nextNode()
	}

	const elements = root instanceof Element ? [root, ...root.querySelectorAll("*")] : []
	for (const element of elements) {
		if (skipElement(element)) continue
		for (const attribute of ["placeholder", "title", "aria-label"]) {
			const value = element.getAttribute(attribute)
			if (!value) continue
			const next = translateValue(value)
			if (next === value) continue
			let saved = originalAttributes.get(element)
			if (!saved) {
				saved = new Map()
				originalAttributes.set(element, saved)
			}
			if (!saved.has(attribute)) saved.set(attribute, value)
			element.setAttribute(attribute, next)
		}
	}
}

function restoreEnglish(): void {
	for (const [text, value] of originalText) {
		if (text.isConnected) text.data = value
	}
	originalText.clear()
	for (const [element, attributes] of originalAttributes) {
		if (!element.isConnected) continue
		for (const [name, value] of attributes) element.setAttribute(name, value)
	}
	originalAttributes.clear()
}

export function LegacyI18nBridge() {
	const { language } = useI18n()

	useEffect(() => {
		document.documentElement.lang = language
		if (language !== "ko") {
			restoreEnglish()
			return
		}

		translateTree(document.body)
		const observer = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				if (mutation.type === "characterData") translateTree(mutation.target)
				for (const node of mutation.addedNodes) translateTree(node)
			}
		})
		observer.observe(document.body, { subtree: true, childList: true, characterData: true })
		return () => observer.disconnect()
	}, [language])

	return null
}
