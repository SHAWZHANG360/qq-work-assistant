import unittest
from doctor import stage, summarize_runtime

class DoctorTest(unittest.TestCase):
    def test_no_private_fields_or_raw_errors(self):
        state = {'network': {'state':'connected'},'bound':True,'lastError':'private error',
                 'pairingCommand':'private code','appId':'private id','report':'private report'}
        result = summarize_runtime(state)
        self.assertEqual(set(result), {'reachable','qq','bound','analysisReady','hasError','sharingEnabled'})
        self.assertTrue(result['hasError'])
        self.assertNotIn('private', str(result))

    def test_stages_distinguish_install_configure_bind_and_validate(self):
        s = dict(supportedOS=True,supportedArch=True,systemd=True,installationExists=False,
                 existingState=False,credentials='missing',runtime={'reachable':False})
        self.assertEqual(stage(s),'ready_to_install')
        s['existingState']=True
        self.assertEqual(stage(s),'review_existing_paths')
        s['installationExists']=True
        self.assertEqual(stage(s),'needs_credentials_or_permissions')
        s['credentials']='root_600'
        self.assertEqual(stage(s),'needs_service_start_or_diagnosis')
        s['runtime']=dict(reachable=True,qq='connected',bound=False,hasError=False)
        self.assertEqual(stage(s),'needs_human_qq_binding')
        s['runtime']['bound']=True
        self.assertEqual(stage(s),'ready_for_message_test')
        s['supportedOS']=False
        self.assertEqual(stage(s),'unsupported_environment')

if __name__ == '__main__':
    unittest.main()
