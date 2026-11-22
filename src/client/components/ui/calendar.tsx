import { DayPicker, type DayPickerProps } from "react-day-picker";
import { ja } from "date-fns/locale";
import { cn } from "@/lib/utils";
import "react-day-picker/style.css";

/** shadcn/ui の Calendar(react-day-picker)。日本語・月曜はじまりではなく日曜はじまり */
export function Calendar({ className, ...props }: DayPickerProps) {
  return (
    <DayPicker
      locale={ja}
      showOutsideDays
      className={cn("fqp-calendar", className)}
      {...props}
    />
  );
}
