import { EC2Client, StartInstancesCommand } from "@aws-sdk/client-ec2";

// Starts the engine's EC2 server, which stops itself after 15 idle minutes (engine/aws/idle-stop.sh). Credentials
// come from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY: an IAM user allowed only ec2:StartInstances on this server.

/** Asking more often than this doesn't start it any sooner. */
const MIN_GAP_MS = 30_000;

export function ec2Waker(opts: {
  instanceId: string;
  region: string;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}): () => Promise<void> {
  const ec2 = new EC2Client({ region: opts.region });
  let askedAt = -Infinity;
  return async () => {
    if (Date.now() - askedAt < MIN_GAP_MS) return;
    askedAt = Date.now();
    try {
      const out = await ec2.send(new StartInstancesCommand({ InstanceIds: [opts.instanceId] }));
      const state = out.StartingInstances?.[0];
      opts.log.info({ from: state?.PreviousState?.Name, to: state?.CurrentState?.Name }, "engine server starting");
    } catch (err) {
      // Most often it is still stopping from its last idle spell; the next message asks again.
      opts.log.warn({ err }, "couldn't start the engine server");
    }
  };
}
