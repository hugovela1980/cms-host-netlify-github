import assert from "node:assert/strict";
import test from "node:test";

import {
    UNRESOLVED_CMS_PUBLICATION_STATUSES,
    isCmsPublicationUnresolved,
    publicPublicationStatus,
} from "../src/server/publication/status.js";

test("only active or uncertain publications are unresolved", () => {
    assert.deepEqual([...UNRESOLVED_CMS_PUBLICATION_STATUSES], ["committing", "deploying", "uncertain"]);
    for (const status of UNRESOLVED_CMS_PUBLICATION_STATUSES) {
        assert.equal(isCmsPublicationUnresolved({ status }), true);
    }
    assert.equal(isCmsPublicationUnresolved({ status: "confirmed" }), false);
    assert.equal(isCmsPublicationUnresolved(null), false);
});

test("public status includes only the established API fields and defaults", () => {
    assert.equal(publicPublicationStatus(null), null);
    assert.deepEqual(publicPublicationStatus({ id: "example", privateToken: "secret" }), {
        id: "example", status: "unknown", startedAt: null, updatedAt: null,
        startedBy: null, title: null, commitSha: null, confirmedAt: null,
        errorCode: null, deploy: null,
    });
});
