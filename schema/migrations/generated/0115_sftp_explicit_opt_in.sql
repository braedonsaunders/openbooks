BEGIN;

ALTER TABLE sftp_daemon ALTER COLUMN enabled SET DEFAULT false;

-- Auto-provisioned listeners have no actor. If no SFTP login has ever been
-- configured, close the listener; an administrator can explicitly enable it
-- after creating the deployment's SFTP configuration.
UPDATE sftp_daemon daemon
   SET enabled = false,
       updated_at = now()
 WHERE daemon.id = 'default'
   AND daemon.enabled
   AND daemon.created_by IS NULL
   AND daemon.updated_by IS NULL
   AND NOT EXISTS (SELECT 1 FROM sftp_servers);

COMMIT;
