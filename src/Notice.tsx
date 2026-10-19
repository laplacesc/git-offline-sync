import { ReactNode } from "react";
import { Alert } from "@heroui/react";

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
    <Alert status={tone} className="flash" data-tone={tone}
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}>
      <Alert.Indicator aria-hidden="true">{indicator}</Alert.Indicator>
      <Alert.Content>
        {title && <Alert.Title>{title}</Alert.Title>}
        {children && <Alert.Description<"div"> render={(props) => <div {...props} />} className="break-words">{children}</Alert.Description>}
      </Alert.Content>
      {actions && <div className="notice-actions">{actions}</div>}
    </Alert>
  );
}
