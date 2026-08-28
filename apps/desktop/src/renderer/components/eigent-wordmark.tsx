import { cn } from "@palot/ui/lib/utils"

export function EigentWordmark({ className }: { className?: string }) {
	return (
		<span aria-label="EIGENT" className={cn("inline-flex items-center font-semibold tracking-[0.18em] leading-none", className)}>
			EIGENT
		</span>
	)
}
