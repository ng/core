ALTER TABLE `side_settings` ADD `auto_on_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `side_settings` ADD `auto_on_minutes` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `side_settings` ADD `auto_on_start` text DEFAULT '20:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `side_settings` ADD `auto_on_end` text DEFAULT '08:00' NOT NULL;