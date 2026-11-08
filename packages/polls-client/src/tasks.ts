// The Trust Task types a poll uses. A "poll" in VTI is an election (`vtc/elections/*`); there is no separate poll family.
// Versions are the newest the upstream bundles define (vti-specs-vtc, vti-specs-vta, vti-voting-service dispatch).
// The kit's pinned VTC does not serve any of them (built without the `voting` feature): see the package README.
import { TT } from "@starter/vta-client";

export const POLL_TASK = {
  // The community (registrar). create/close/cancel/ballot-boxes need `vtc.elections.manage`; list/show take any signer.
  create: `${TT}/vtc/elections/create/0.5`,
  list: `${TT}/vtc/elections/list/0.5`,
  show: `${TT}/vtc/elections/show/0.6`,
  close: `${TT}/vtc/elections/close/0.1`,
  cancel: `${TT}/vtc/elections/cancel/0.1`,
  ballotBoxes: `${TT}/vtc/elections/ballot-boxes/list/0.1`,
  ticketsIssue: `${TT}/vtc/elections/tickets/issue/0.3`,
  // The member's VTA (voter). Every one needs the `pcs-voter` capability, which the `application` role lacks.
  voterRead: `${TT}/vta/pcs/voter/read/0.6`,
  voterRegister: `${TT}/vta/pcs/voter/register/0.5`,
  voterAccept: `${TT}/vta/pcs/voter/accept/0.1`,
  voterReceipt: `${TT}/vta/pcs/voter/receipt/0.1`,
  vote: `${TT}/vta/pcs/vote/0.4`,
  // The ballot box (vti-voting-service).
  cast: `${TT}/voting/ballot/cast/0.1`,
  resultShow: `${TT}/voting/result/show/0.1`,
} as const;
