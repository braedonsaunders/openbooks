/**
 * Helpers for transcribing a publication's own notation without translating it.
 *
 * Several states print their rates as PERCENTAGES with the percent sign — New
 * Jersey's rate tables print "1.5%", Ohio's school district list prints
 * "1.25 %" — while every rate this engine multiplies by is a decimal fraction.
 * The conversion has to happen somewhere, and where it happens decides what a
 * reviewer can check.
 *
 * Doing it by hand at transcription time means the constant in the module is
 * `"0.0125"` and the publication says `1.25 %`, so proof-reading 214 school
 * districts against the PDF is 214 mental divisions, each of which can go
 * wrong silently. Doing it HERE means the module carries the publication's own
 * digits — `"1.25"` — and a reviewer's eye compares like with like.
 *
 * The conversion is an exact decimal-point shift on the string. No float, no
 * division: `1.25 → 0.0125`, `0.50 → 0.0050`, `11.8 → 0.118`. A float would
 * turn 2.9% into 0.028999999999999998 and the meta-test that forbids floating
 * point in statutory modules would be right to fail it.
 */
import { PayrollError } from "../../../payroll-error.ts";

export class UsStateTranscriptionError extends PayrollError {}

/**
 * A percentage as the publication prints it → the decimal rate to multiply by.
 *
 * Shifts the decimal point two places left on the digit string itself.
 */
export function pctToRate(printed: string): string {
  const raw = printed.trim().replace(/\s*%$/, "");
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new UsStateTranscriptionError(
      `not a percentage as a publication prints one: "${printed}"`,
    );
  }
  const [whole = "0", fraction = ""] = raw.split(".");
  const digits = whole + fraction;
  // Two zeros of headroom so a one-digit whole part still has somewhere to go.
  const padded = "00" + digits;
  const point = padded.length - fraction.length - 2;
  const left = padded.slice(0, point).replace(/^0+(?=\d)/, "");
  const right = padded.slice(point);
  return right.length > 0 ? `${left}.${right}` : left;
}
