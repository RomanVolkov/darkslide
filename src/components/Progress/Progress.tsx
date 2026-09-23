import s from "./Progress.module.css"

export interface ProgressProps {
    done: number;
    total: number;
}

export function Progress({ title, progress }: { title: string; progress: ProgressProps }) {
    const total = progress.total > 0 ? progress.total : 0;
    const pct = total > 0 ? (progress.done / total) * 100 : 0;
    return (<div className={s.progress}>
        <div className={s.progressLabel}>
            {title} {progress.done}/{total}
        </div>
        <div className={s.progressTrack}>
            <div
                className={s.progressFill}
                style={{ width: `${pct}%` }}
            />
        </div>
    </div>
    )
}