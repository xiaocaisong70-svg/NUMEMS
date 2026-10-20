CREATE TABLE `portal_state` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`document` text NOT NULL
);
