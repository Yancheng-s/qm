const STATUS_LABELS: Record<string, string> = {
  active: "进行中",
  enabled: "已启用",
  disabled: "已停用",
  pending: "待处理",
  running: "运行中",
  deploying: "正在部署",
  stopped: "已停止",
  archived: "已归档",
  failed: "失败",
  error: "错误",
  done: "已完成",
  complete: "已完成",
  completed: "已完成",
  success: "成功",
  succeeded: "成功",
  queued: "已排队",
  waiting: "等待中",
  paused: "已暂停",
  blocked: "受阻",
  cancelled: "已取消",
  canceled: "已取消",
  quarantined: "已隔离",
  held: "待审核",
  shipping: "交付中",
  shipped: "已交付",
  returned: "已退回",
  unconfirmed: "待确认",
  superseded: "已被替代",
  idle: "空闲",
  ready: "已就绪",
  open: "待处理",
  claimed: "已领取",
  parked: "已搁置",
  exhausted: "已耗尽",
  expired: "已过期",
  unknown: "未知",
};
export function displayStatus(value: string | null | undefined): string {
  return STATUS_LABELS[value ?? "unknown"] ?? value ?? "未知";
}
export function scopeTypeLabel(value: string): string {
  return (
    (
      { personal: "个人", channel: "频道", group: "群组", team: "团队", org: "组织", global: "全局" } as Record<
        string,
        string
      >
    )[value] ?? value
  );
}
