__menu = {
    'uri': __package__,
    'name': 'Supertonic TTS',
    'list': [
        {
            'uri': 'main',
            'name': '대시보드'
        },
        {
            'uri': 'setting',
            'name': '설정'
        },
        {
            'uri': 'log',
            'name': '로그'
        }
    ]
}

setting = {
    'filepath': __file__,
    'use_db': True,
    'use_default_setting': True,
    'home_module': 'main',
    'menu': __menu,
    'default_route': 'single',
}

from plugin import *
import os
import traceback
from flask import render_template

class LogicModule(PluginModuleBase):
    def __init__(self, P):
        super(LogicModule, self).__init__(P, name='main', first_menu='main')

    def process_menu(self, sub, req):
        if sub == 'log':
            return render_template('supertonic_tts_log.html', package=self.P.package_name)
        return render_template('supertonic_tts_main.html', package=self.P.package_name)

    def process_ajax(self, sub, req):
        return self.get_module('logic').process_ajax(sub, req)

P = create_plugin_instance(setting)

try:
    from .logic import Logic
    P.set_module_list([LogicModule, Logic])
except Exception as e:
    P.logger.error(f'Exception: {str(e)}')
    P.logger.error(traceback.format_exc())
