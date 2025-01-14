// Tests rollback of auth data in replica sets.
// This test creates a user and then does two different sets of updates to that user's privileges
// using the replSetTest command to trigger a rollback and verify that at the end the access control
// data is rolled back correctly and the user only has access to the expected collections.
//
// If all data-bearing nodes in a replica set are using an ephemeral storage engine, the set will
// not be able to survive a scenario where all data-bearing nodes are down simultaneously. In such a
// scenario, none of the members will have any data, and upon restart will each look for a member to
// inital sync from, so no primary will be elected. This test induces such a scenario, so cannot be
// run on ephemeral storage engines.
// @tags: [requires_persistence]

(function() {
    "use strict";

    // Arbiters don't replicate the admin.system.keys collection, so they can never validate or sign
    // clusterTime. Gossiping a clusterTime to an arbiter as a user other than __system will fail,
    // so we skip gossiping for this test.
    //
    // TODO SERVER-32639: remove this flag.
    TestData.skipGossipingClusterTime = true;

    // TODO SERVER-35447: Multiple users cannot be authenticated on one connection within a session.
    TestData.disableImplicitSessions = true;

    // helper function for verifying contents at the end of the test
    var checkFinalResults = function(db) {
        assert.commandWorked(db.runCommand({dbStats: 1}));
        assert.commandFailedWithCode(db.runCommand({collStats: 'foo'}), authzErrorCode);
        assert.commandFailedWithCode(db.runCommand({collStats: 'bar'}), authzErrorCode);
        assert.commandWorked(db.runCommand({collStats: 'baz'}));
        assert.commandWorked(db.runCommand({collStats: 'foobar'}));
    };

    var authzErrorCode = 13;

    jsTestLog("Setting up replica set");

    var name = "rollbackAuth";
    var replTest = new ReplSetTest({name: name, nodes: 3, keyFile: 'jstests/libs/key1'});
    var nodes = replTest.nodeList();
    var conns = replTest.startSet();
    replTest.initiate({
        "_id": "rollbackAuth",
        "members": [
            {"_id": 0, "host": nodes[0], "priority": 3},
            {"_id": 1, "host": nodes[1]},
            {"_id": 2, "host": nodes[2], arbiterOnly: true}
        ]
    });

    // Make sure we have a master
    replTest.waitForState(replTest.nodes[0], ReplSetTest.State.PRIMARY);
    var master = replTest.getPrimary();
    var a_conn = conns[0];
    var b_conn = conns[1];
    a_conn.setSlaveOk();
    b_conn.setSlaveOk();
    var A = a_conn.getDB("admin");
    var B = b_conn.getDB("admin");
    var a = a_conn.getDB("test");
    var b = b_conn.getDB("test");
    assert.eq(master, conns[0], "conns[0] assumed to be master");
    assert.eq(a_conn, master);

    // Make sure we have an arbiter
    assert.soon(function() {
        var res = conns[2].getDB("admin").runCommand({replSetGetStatus: 1});
        return res.myState == 7;
    }, "Arbiter failed to initialize.");

    jsTestLog("Creating initial data");

    // Create collections that will be used in test
    A.createUser(
        {user: 'admin', pwd: 'Password@a1b', roles: ['root'], "passwordDigestor": "server"});
    A.auth('admin', 'Password@a1b');
    a.foo.insert({a: 1});
    a.bar.insert({a: 1});
    a.baz.insert({a: 1});
    a.foobar.insert({a: 1});

    // Set up user admin user
    A.createUser({
        user: 'userAdmin',
        pwd: 'Password@a1b',
        roles: ['userAdminAnyDatabase'], "passwordDigestor": "server"
    });
    A.auth('userAdmin', 'Password@a1b');  // Logs out of admin@admin user
    B.auth('userAdmin', 'Password@a1b');

    // Create a basic user and role
    A.createRole({
        role: 'replStatusRole',  // To make awaitReplication() work
        roles: [],
        privileges: [
            {resource: {cluster: true}, actions: ['replSetGetStatus']},
            {resource: {db: 'local', collection: ''}, actions: ['find']},
            {resource: {db: 'local', collection: 'system.replset'}, actions: ['find']}
        ]
    });
    a.createRole({
        role: 'myRole',
        roles: [],
        privileges: [{resource: {db: 'test', collection: ''}, actions: ['dbStats']}]
    });
    a.createUser({
        user: 'spencer',
        pwd: 'Password@a1b',
        roles: ['myRole', {role: 'replStatusRole', db: 'admin'}], "passwordDigestor": "server"
    });
    assert(a.auth('spencer', 'Password@a1b'));

    // wait for secondary to get this data
    assert.soon(function() {
        return b.auth('spencer', 'Password@a1b');
    });

    assert.commandWorked(a.runCommand({dbStats: 1}));
    assert.commandFailedWithCode(a.runCommand({collStats: 'foo'}), authzErrorCode);
    assert.commandFailedWithCode(a.runCommand({collStats: 'bar'}), authzErrorCode);
    assert.commandFailedWithCode(a.runCommand({collStats: 'baz'}), authzErrorCode);
    assert.commandFailedWithCode(a.runCommand({collStats: 'foobar'}), authzErrorCode);

    assert.commandWorked(b.runCommand({dbStats: 1}));
    assert.commandFailedWithCode(b.runCommand({collStats: 'foo'}), authzErrorCode);
    assert.commandFailedWithCode(b.runCommand({collStats: 'bar'}), authzErrorCode);
    assert.commandFailedWithCode(b.runCommand({collStats: 'baz'}), authzErrorCode);
    assert.commandFailedWithCode(b.runCommand({collStats: 'foobar'}), authzErrorCode);

    jsTestLog("Doing writes that will eventually be rolled back");

    // down A and wait for B to become master
    replTest.stop(0);
    assert.soon(function() {
        try {
            return B.isMaster().ismaster;
        } catch (e) {
            return false;
        }
    }, "B didn't become master");
    printjson(b.adminCommand('replSetGetStatus'));

    // Modify the the user and role in a way that will be rolled back.
    b.grantPrivilegesToRole(
        'myRole',
        [{resource: {db: 'test', collection: 'foo'}, actions: ['collStats']}],
        {});  // Default write concern will wait for majority, which will time out.
    b.createRole({
        role: 'temporaryRole',
        roles: [],
        privileges: [{resource: {db: 'test', collection: 'bar'}, actions: ['collStats']}]
    },
                 {});  // Default write concern will wait for majority, which will time out.
    b.grantRolesToUser('spencer',
                       ['temporaryRole'],
                       {});  // Default write concern will wait for majority, which will time out.

    assert.commandWorked(b.runCommand({dbStats: 1}));
    assert.commandWorked(b.runCommand({collStats: 'foo'}));
    assert.commandWorked(b.runCommand({collStats: 'bar'}));
    assert.commandFailedWithCode(b.runCommand({collStats: 'baz'}), authzErrorCode);
    assert.commandFailedWithCode(b.runCommand({collStats: 'foobar'}), authzErrorCode);

    // down B, bring A back up, then wait for A to become master
    // insert new data into A so that B will need to rollback when it reconnects to A
    replTest.stop(1);

    replTest.restart(0);
    assert.soon(function() {
        try {
            return A.isMaster().ismaster;
        } catch (e) {
            return false;
        }
    }, "A didn't become master");

    // A should not have the new data as it was down
    assert.commandWorked(a.runCommand({dbStats: 1}));
    assert.commandFailedWithCode(a.runCommand({collStats: 'foo'}), authzErrorCode);
    assert.commandFailedWithCode(a.runCommand({collStats: 'bar'}), authzErrorCode);
    assert.commandFailedWithCode(a.runCommand({collStats: 'baz'}), authzErrorCode);
    assert.commandFailedWithCode(a.runCommand({collStats: 'foobar'}), authzErrorCode);

    jsTestLog("Doing writes that should persist after the rollback");
    // Modify the user and role in a way that will persist.
    A.auth('userAdmin', 'Password@a1b');
    // Default write concern will wait for majority, which would time out
    // so we override it with an empty write concern
    a.grantPrivilegesToRole(
        'myRole', [{resource: {db: 'test', collection: 'baz'}, actions: ['collStats']}], {});

    a.createRole({
        role: 'persistentRole',
        roles: [],
        privileges: [{resource: {db: 'test', collection: 'foobar'}, actions: ['collStats']}]
    },
                 {});
    a.grantRolesToUser('spencer', ['persistentRole'], {});
    A.logout();
    a.auth('spencer', 'Password@a1b');

    // A has the data we just wrote, but not what B wrote before
    checkFinalResults(a);

    jsTestLog("Triggering rollback");

    // bring B back in contact with A
    // as A is primary, B will roll back and then catch up
    replTest.restart(1);
    authutil.asCluster(replTest.nodes, 'jstests/libs/key1', function() {
        replTest.awaitReplication();
    });
    assert.soon(function() {
        return b.auth('spencer', 'Password@a1b');
    });
    // Now both A and B should agree
    checkFinalResults(a);
    checkFinalResults(b);

    // Verify data consistency between nodes.
    authutil.asCluster(replTest.nodes, 'jstests/libs/key1', function() {
        replTest.checkOplogs();
    });

    // DB hash check is done in stopSet.
    replTest.stopSet();
}());
