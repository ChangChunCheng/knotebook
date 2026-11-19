import { ChevronLeft, Copy, CornerDownRight, Folder, House, Share, User, Users } from "@/components/ui/icons";
import type { DestItem } from "./destination-level";

export function destinationItemIcon(item: DestItem): typeof Folder | null {
  if (item.kind === "back") return ChevronLeft;
  if (item.kind === "folder") return Folder;
  if (item.kind === "makeCopy") return Copy;
  if (item.kind === "root") return House;
  if (item.kind === "here") return CornerDownRight;
  if (item.kind !== "space" || item.target.kind !== "place") return null;
  const { space } = item.target;
  if (space.kind === "personal") return User;
  return space.kind === "group" ? Users : Share;
}
