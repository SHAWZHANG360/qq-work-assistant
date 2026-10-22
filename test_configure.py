import json
import tempfile
import unittest
from pathlib import Path
from configure import validate, verify, save_atomic, update_sharing, SetupError, NoRedirect

def example():
    return dict(appId='123456789', qqAppSecret='test-only-qq-secret-value', deepseekApiKey='test-only-api-key-value', name='', organization='', department='')

class ConfigureTests(unittest.TestCase):
    def test_sharing_is_optional_boolean_and_update_preserves_secrets_with_backup(self):
        self.assertNotIn('sharingEnabled',validate(example()))
        for value in ['true',1,None,[]]:
            with self.assertRaises(SetupError): validate({**example(),'sharingEnabled':value})
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'config.json'
            save_atomic(example(),file)
            raw=file.read_bytes()
            backup=update_sharing(True,file)
            self.assertEqual(backup.read_bytes(),raw)
            self.assertEqual(json.loads(file.read_text()),{**example(),'sharingEnabled':True})
            update_sharing(False,file)
            self.assertEqual(json.loads(file.read_text()),{**example(),'sharingEnabled':False})
    def test_validation_and_atomic_save(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'config.json'
            save_atomic(example(),file)
            before=file.read_bytes()
            with self.assertRaises(SetupError):
                save_atomic({**example(),'qqAppSecret':''},file)
            self.assertEqual(before,file.read_bytes())
            self.assertEqual(list(Path(directory).iterdir()),[file])
    def test_verification_uses_only_official_urls_and_does_not_return_tokens(self):
        calls=[]
        def request(url,**kwargs):
            calls.append((url,kwargs))
            return [{'access_token':'test-only-token'},{'url':'wss://test.example'},{'data':[{'id':'deepseek-flash'}]}][len(calls)-1]
        self.assertIsNone(verify(example(),request))
        self.assertEqual([x[0] for x in calls],['https://api.bot.qq.com/app/getAppAccessToken','https://api.bot.qq.com/gateway','https://api.deepseek.com/models'])
        self.assertEqual(calls[1][1]['headers']['Authorization'],'QQBot test-only-token')
    def test_http_success_without_token_is_not_success(self):
        with self.assertRaises(SetupError): verify(example(),lambda *a,**k:{'errcode':1})
    def test_redirect_is_rejected(self):
        with self.assertRaises(SetupError): NoRedirect().redirect_request(None,None,302,'',{},'https://example.org')
    def test_unknown_fields_and_control_characters(self):
        for patch in [{'name':'x\n'},{'appId':'abc'},{'extra':'value'},{'deepseekApiKey':'a'*20+'\t'}]:
            with self.assertRaises(SetupError): validate({**example(),**patch})

if __name__=='__main__': unittest.main()
