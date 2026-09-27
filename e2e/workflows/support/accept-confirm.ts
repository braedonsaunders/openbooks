import { expect, type Page } from "@playwright/test";
import common from "../../../web/messages/en/common.json";

export async function acceptConfirm(page: Page): Promise<void> {
  const dialog = page.locator('[role="dialog"][aria-labelledby="confirm-title"]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: common.confirm.confirm, exact: true }).click();
}
