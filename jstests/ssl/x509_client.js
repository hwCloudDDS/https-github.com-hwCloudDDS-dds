// Check if this build supports the authenticationMechanisms startup parameter.
var conn = MongoRunner.runMongod({
    smallfiles: "",
    auth: "",
    sslMode: "requireSSL",
    sslPEMKeyFile: "jstests/libs/server.pem",
    sslCAFile: "jstests/libs/ca.pem"
});
conn.getDB('admin').createUser(
    {user: "admin", pwd: "Password@a1b", roles: ["root"], "passwordDigestor": "server"});
conn.getDB('admin').auth("admin", "Password@a1b");
var cmdOut = conn.getDB('admin').runCommand({getParameter: 1, authenticationMechanisms: 1});
if (cmdOut.ok) {
    TestData.authMechanism = "MONGODB-X509,SCRAM-SHA-1";  // SERVER-10353
}
conn.getDB('admin').dropAllUsers();
conn.getDB('admin').logout();
MongoRunner.stopMongod(conn);

var SERVER_CERT = "jstests/libs/server.pem";
var CA_CERT = "jstests/libs/ca.pem";

var SERVER_USER = "C=US,ST=New York,L=New York City,O=MongoDB,OU=Kernel,CN=server";
var INTERNAL_USER = "C=US,ST=New York,L=New York City,O=MongoDB,OU=Kernel,CN=internal";
var CLIENT_USER = "C=US,ST=New York,L=New York City,O=MongoDB,OU=KernelUser,CN=client";
var INVALID_CLIENT_USER = "C=US,ST=New York,L=New York City,O=MongoDB,OU=KernelUser,CN=invalid";

function authAndTest(mongo) {
    external = mongo.getDB("$external");
    test = mongo.getDB("test");

    // It should be impossible to create users with the same name as the server's subject
    assert.throws(function() {
        external.createUser(
            {user: SERVER_USER, roles: [{'role': 'userAdminAnyDatabase', 'db': 'admin'}]});
    }, [], "Created user with same name as the server's x.509 subject");

    // It should be impossible to create users with names recognized as cluster members
    assert.throws(function() {
        external.createUser({
            user: INTERNAL_USER,
            roles: [{'role': 'userAdminAnyDatabase', 'db': 'admin'}], "passwordDigestor": "server"
        });
    }, [], "Created user which would be recognized as a cluster member");

    // Add user using localhost exception
    external.createUser({
        user: CLIENT_USER,
        roles: [
            {'role': 'userAdminAnyDatabase', 'db': 'admin'},
            {'role': 'readWriteAnyDatabase', 'db': 'admin'}
        ]
    });

    // It should be impossible to create users with an internal name
    assert.throws(function() {
        external.createUser({
            user: SERVER_USER,
            roles: [{'role': 'userAdminAnyDatabase', 'db': 'admin'}], "passwordDigestor": "server"
        });
    });

    // Localhost exception should not be in place anymore
    assert.throws(function() {
        test.foo.findOne();
    }, [], "read without login");

    assert(!external.auth({user: INVALID_CLIENT_USER, mechanism: 'MONGODB-X509'}),
           "authentication with invalid user should fail");
    assert(external.auth({user: CLIENT_USER, mechanism: 'MONGODB-X509'}),
           "authentication with valid user failed");
    assert(external.auth({mechanism: 'MONGODB-X509'}),
           "authentication with valid client cert and no user field failed");
    assert(external.runCommand({authenticate: 1, mechanism: 'MONGODB-X509', user: CLIENT_USER}).ok,
           "runCommand authentication with valid client cert and user field failed");
    assert(external.runCommand({authenticate: 1, mechanism: 'MONGODB-X509'}).ok,
           "runCommand authentication with valid client cert and no user field failed");

    // Check that we can add a user and read data
    test.createUser({
        user: "test",
        pwd: "Password@a1b",
        roles: [{'role': 'readWriteAnyDatabase', 'db': 'admin'}], "passwordDigestor": "server"
    });
    test.foo.findOne();

    external.logout();
    assert.throws(function() {
        test.foo.findOne();
    }, [], "read after logout");
}

print("1. Testing x.509 auth to mongod");
var x509_options = {sslMode: "requireSSL", sslPEMKeyFile: SERVER_CERT, sslCAFile: CA_CERT};

var mongo = MongoRunner.runMongod(Object.merge(x509_options, {auth: ""}));

authAndTest(mongo);
MongoRunner.stopMongod(mongo);

print("2. Testing x.509 auth to mongos");

var st = new ShardingTest({
    shards: 1,
    mongos: 1,
    other: {
        keyFile: 'jstests/libs/key1',
        configOptions: x509_options,
        mongosOptions: x509_options,
        shardOptions: x509_options,
        useHostname: false,
    }
});

authAndTest(new Mongo("localhost:" + st.s0.port));
st.stop();
