import { ReactNode } from "react";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";

export type Tone = "success" | "warning" | "danger" | "accent" | "default";

/** 操作反馈与页面状态共用的横幅，详细内容和后续操作保留在横幅内。 */
export function Notice({ tone, title, children, actions, indicator }: {
  tone: Tone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  indicator?: ReactNode;
}) {
  return (
    <Alert variant={tone === "danger" ? "destructive" : "default"} className="flash flex items-start gap-3" data-tone={tone}
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}>
      <span className="notice-indicator" aria-hidden="true">{indicator ?? (tone === "success" ? <CircleCheckIcon className="size-4" /> : <CircleAlertIcon className="size-4" />)}</span>
      <div className="notice-content">
        {title && <AlertTitle>{title}</AlertTitle>}
        {children && <AlertDescription className="break-words">{children}</AlertDescription>}
      </div>
      {actions && <div className="notice-actions">{actions}</div>}
    </Alert>
  );
}
