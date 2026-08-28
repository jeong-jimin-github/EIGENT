import { atom } from "jotai"
import { atomWithStorage } from "jotai/utils"

export type LanguagePreference = "system" | "en" | "ko"
export type AppLanguage = "en" | "ko"

export const languagePreferenceAtom = atomWithStorage<LanguagePreference>("eigent:language", "system")

function systemLanguage(): AppLanguage {
	return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en"
}

export const appLanguageAtom = atom<AppLanguage>((get) => {
	const preference = get(languagePreferenceAtom)
	return preference === "system" ? systemLanguage() : preference
})

const en = {
	"common.cancel": "Cancel", "common.loading": "Loading...",
	"sidebar.serverOffline": "Server offline", "sidebar.checkConnection": "Check your connection in Settings",
	"sidebar.noProjects": "No projects yet", "sidebar.addProjectHint": "Add a project to get started",
	"sidebar.newSession": "New Session", "sidebar.automations": "Automations", "sidebar.activeNow": "Active Now",
	"sidebar.recent": "Recent", "sidebar.projects": "Projects", "sidebar.searchProjects": "Search projects",
	"sidebar.closeSearch": "Close search", "sidebar.commandPalette": "Command palette", "sidebar.addProject": "Add project",
	"sidebar.filterProjects": "Filter projects...", "sidebar.noProjectMatches": "No projects match", "sidebar.settings": "Settings",
	"sidebar.projectTools": "Project tools", "sidebar.loadingSessions": "Loading sessions...", "sidebar.noSessions": "No sessions yet",
	"sidebar.loadMore": "Load more sessions", "sidebar.rename": "Rename", "sidebar.fork": "Fork", "sidebar.delete": "Delete",
	"sidebar.removeProject": "Remove project", "sidebar.toggle": "Toggle sidebar",
	"project.addTitle": "Add Project", "project.addDescription": "Enter the absolute path to a project directory available to this EIGENT server.",
	"project.path": "Directory Path", "project.pathHint": "The directory must exist on the server running EIGENT.",
	"project.add": "Add Project", "project.addFailed": "Failed to add project. Check that the path exists and is accessible.",
	"settings.back": "Back to app", "settings.general": "General", "settings.notifications": "Notifications",
	"settings.providers": "Providers", "settings.worktrees": "Worktrees", "settings.language": "Language",
	"settings.languageDescription": "Choose the language used by EIGENT", "settings.system": "System", "settings.english": "English",
	"settings.korean": "한국어", "settings.appearance": "Appearance", "settings.theme": "Theme",
	"settings.themeDescription": "Use light, dark, or match your system", "settings.light": "Light", "settings.dark": "Dark",
	"settings.opaque": "Use opaque background", "settings.opaqueDescription": "Make windows use a solid background rather than system translucency",
	"settings.displayMode": "Display mode", "settings.displayModeDescription": "Adjust how much detail is shown in conversations",
	"settings.default": "Default", "settings.verbose": "Verbose", "settings.openDestination": "Default open destination",
	"settings.openDestinationDescription": "Where files and folders open by default", "settings.select": "Select...",
	"server.name": "EIGENT Server", "server.connected": "Connected", "server.offline": "Offline",
	"newChat.local": "Local", "newChat.localHint": "Run in your current working directory", "newChat.worktree": "Worktree", "newChat.worktreeHint": "Run in an isolated git worktree (your working copy stays untouched)",
	"newChat.hero": "Build what's next", "newChat.selectProject": "select project", "newChat.placeholder": "What should this session work on?",
	"newChat.suggestionFeature": "Build a new feature based on the existing patterns in this repo.",
	"newChat.suggestionArchitecture": "Summarize the architecture and key design decisions.",
	"newChat.suggestionReview": "Review recent changes and suggest improvements.",
} as const

export type TranslationKey = keyof typeof en

const ko: Record<TranslationKey, string> = {
	"common.cancel": "취소", "common.loading": "불러오는 중...",
	"sidebar.serverOffline": "서버 오프라인", "sidebar.checkConnection": "설정에서 연결 상태를 확인하세요",
	"sidebar.noProjects": "프로젝트가 없습니다", "sidebar.addProjectHint": "프로젝트를 추가해 시작하세요",
	"sidebar.newSession": "새 세션", "sidebar.automations": "자동화", "sidebar.activeNow": "실행 중",
	"sidebar.recent": "최근", "sidebar.projects": "프로젝트", "sidebar.searchProjects": "프로젝트 검색",
	"sidebar.closeSearch": "검색 닫기", "sidebar.commandPalette": "명령 팔레트", "sidebar.addProject": "프로젝트 추가",
	"sidebar.filterProjects": "프로젝트 필터...", "sidebar.noProjectMatches": "일치하는 프로젝트 없음", "sidebar.settings": "설정",
	"sidebar.projectTools": "프로젝트 도구", "sidebar.loadingSessions": "세션 불러오는 중...", "sidebar.noSessions": "세션이 없습니다",
	"sidebar.loadMore": "세션 더 불러오기", "sidebar.rename": "이름 변경", "sidebar.fork": "포크", "sidebar.delete": "삭제",
	"sidebar.removeProject": "프로젝트 제거", "sidebar.toggle": "사이드바 전환",
	"project.addTitle": "프로젝트 추가", "project.addDescription": "이 EIGENT 서버에서 접근 가능한 프로젝트의 절대 경로를 입력하세요.",
	"project.path": "디렉터리 경로", "project.pathHint": "EIGENT가 실행 중인 서버에 존재하는 디렉터리여야 합니다.",
	"project.add": "프로젝트 추가", "project.addFailed": "프로젝트를 추가하지 못했습니다. 경로와 접근 권한을 확인하세요.",
	"settings.back": "앱으로 돌아가기", "settings.general": "일반", "settings.notifications": "알림",
	"settings.providers": "프로바이더", "settings.worktrees": "워크트리", "settings.language": "언어",
	"settings.languageDescription": "EIGENT에서 사용할 언어를 선택합니다", "settings.system": "시스템", "settings.english": "English",
	"settings.korean": "한국어", "settings.appearance": "화면", "settings.theme": "테마",
	"settings.themeDescription": "밝게, 어둡게 또는 시스템 설정을 사용합니다", "settings.light": "밝게", "settings.dark": "어둡게",
	"settings.opaque": "불투명 배경 사용", "settings.opaqueDescription": "시스템 반투명 효과 대신 단색 배경을 사용합니다",
	"settings.displayMode": "표시 모드", "settings.displayModeDescription": "대화에 표시할 정보량을 조절합니다",
	"settings.default": "기본", "settings.verbose": "상세", "settings.openDestination": "기본 열기 위치",
	"settings.openDestinationDescription": "파일과 폴더를 기본으로 열 위치입니다", "settings.select": "선택...",
	"server.name": "EIGENT 서버", "server.connected": "연결됨", "server.offline": "오프라인",
	"newChat.local": "로컬", "newChat.localHint": "현재 작업 디렉터리에서 실행", "newChat.worktree": "워크트리", "newChat.worktreeHint": "격리된 Git 워크트리에서 실행합니다 (현재 작업 복사본은 변경하지 않음)",
	"newChat.hero": "다음 작업을 시작하세요", "newChat.selectProject": "프로젝트 선택", "newChat.placeholder": "이 세션에서 무엇을 작업할까요?",
	"newChat.suggestionFeature": "이 저장소의 기존 패턴을 따라 새 기능을 구현해 주세요.",
	"newChat.suggestionArchitecture": "아키텍처와 주요 설계 결정을 요약해 주세요.",
	"newChat.suggestionReview": "최근 변경사항을 검토하고 개선점을 제안해 주세요.",
}

const messages: Record<AppLanguage, Record<TranslationKey, string>> = { en, ko }
export function translate(language: AppLanguage, key: TranslationKey): string { return messages[language][key] ?? en[key] }
