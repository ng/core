CREATE TABLE `flash_write_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`boot_id` text NOT NULL,
	`sectors_written` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_flash_write_samples_timestamp` ON `flash_write_samples` (`timestamp`);