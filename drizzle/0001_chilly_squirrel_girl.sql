CREATE TABLE `portal_history` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`email` text NOT NULL,
	`user_id` text NOT NULL,
	`sort_at` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE INDEX `portal_history_kind_date` ON `portal_history` (`kind`,`sort_at`,`id`);--> statement-breakpoint
CREATE INDEX `portal_history_owner_date` ON `portal_history` (`kind`,`email`,`user_id`,`sort_at`,`id`);